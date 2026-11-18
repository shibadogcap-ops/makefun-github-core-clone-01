// Contents API (files in a repo tree) and the commits list endpoint.

import { HttpError, type Ctx, type Router } from './app.ts';
import { mustRepo } from './repos.ts';
import {
  branchTip,
  DEFAULT_BRANCH,
  tickEpochSec,
  VIEWER_EMAIL,
  VIEWER_NAME,
  type RepoRec,
} from './store.ts';
import {
  buildCommitData,
  buildTreeFromFiles,
  EMPTY_TREE_OID,
  flattenTree,
  identLine,
  parseCommit,
  parseTree,
  storeObject,
  treeEntryAt,
} from './gitobj.ts';

function tipTree(repo: RepoRec, branch: string): { tip?: string; treeOid: string } {
  const tip = branchTip(repo, branch);
  if (tip === undefined) return { treeOid: EMPTY_TREE_OID };
  const obj = repo.objects.get(tip);
  if (obj === undefined || obj.type !== 'commit') return { tip, treeOid: EMPTY_TREE_OID };
  return { tip, treeOid: parseCommit(obj.data).tree };
}

function commitFiles(repo: RepoRec, branch: string, files: Map<string, string>, message: string): string {
  const treeOid = buildTreeFromFiles(repo, files);
  const { tip } = tipTree(repo, branch);
  const now = tickEpochSec();
  const data = buildCommitData({
    tree: treeOid,
    parents: tip === undefined ? [] : [tip],
    author: identLine(now),
    committer: identLine(tickEpochSec()),
    message,
  });
  const sha = storeObject(repo, 'commit', data);
  repo.refs.set('refs/heads/' + branch, sha);
  return sha;
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function branchOf(body: Record<string, unknown>): string {
  return typeof body.branch === 'string' && body.branch !== '' ? body.branch : DEFAULT_BRANCH;
}

export function registerContents(router: Router): void {
  router.add('PUT', '/api/v3/repos/{owner}/{repo}/contents/{path...}', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const body = ctx.jsonBody() as Record<string, unknown>;
    const content = body.content;
    if (typeof content !== 'string') {
      throw new HttpError(422, 'Validation Failed: content is required');
    }
    const bytes = Buffer.from(content, 'base64');
    const blobOid = storeObject(repo, 'blob', bytes);
    const path = ctx.params.path ?? '';
    const branch = branchOf(body);
    const { treeOid } = tipTree(repo, branch);
    const files = flattenTree(repo, treeOid);
    const existing = files.get(path);
    let status: number;
    if (existing !== undefined) {
      if (body.sha === undefined) {
        throw new HttpError(422, 'Validation Failed: sha is required');
      }
      if (body.sha !== existing.oid) {
        throw new HttpError(409, 'Conflict: sha does not match');
      }
      status = 200;
    } else {
      status = 201;
    }
    const message = typeof body.message === 'string' ? body.message : 'Update ' + path;
    files.set(path, blobOid);
    const commitSha = commitFiles(repo, branch, files, message);
    ctx.json(status, {
      content: {
        name: basename(path),
        path,
        sha: blobOid,
        size: bytes.length,
        type: 'file',
        encoding: 'base64',
      },
      commit: { sha: commitSha, message },
    });
  });

  router.add('GET', '/api/v3/repos/{owner}/{repo}/contents/{path...}', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const refParam = ctx.query.get('ref');
    let tip: string | undefined;
    if (refParam !== null && refParam !== '') {
      const branchTipSha = repo.refs.get('refs/heads/' + refParam);
      if (branchTipSha !== undefined) {
        tip = branchTipSha;
      } else if (/^[0-9a-f]{40}$/.test(refParam) && repo.objects.get(refParam)?.type === 'commit') {
        tip = refParam;
      }
    }
    if (tip === undefined) tip = branchTip(repo, DEFAULT_BRANCH);
    if (tip === undefined) throw new HttpError(404, 'Not Found');
    const obj = repo.objects.get(tip);
    if (obj === undefined || obj.type !== 'commit') throw new HttpError(404, 'Not Found');
    const treeOid = parseCommit(obj.data).tree;
    const path = ctx.params.path ?? '';

    if (path === '') {
      ctx.json(200, listTree(repo, treeOid, ''));
      return;
    }
    const entry = treeEntryAt(repo, treeOid, path);
    if (entry === undefined) throw new HttpError(404, 'Not Found');
    const target = repo.objects.get(entry.oid);
    if (entry.isTree) {
      if (target === undefined || target.type !== 'tree') throw new HttpError(404, 'Not Found');
      ctx.json(200, listTree(repo, entry.oid, path));
      return;
    }
    if (target === undefined || target.type !== 'blob') throw new HttpError(404, 'Not Found');
    ctx.json(200, {
      type: 'file',
      name: basename(path),
      path,
      sha: entry.oid,
      size: target.data.length,
      encoding: 'base64',
      content: target.data.toString('base64'),
    });
  });

  router.add('DELETE', '/api/v3/repos/{owner}/{repo}/contents/{path...}', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const body = ctx.jsonBody() as Record<string, unknown>;
    const path = ctx.params.path ?? '';
    const branch = branchOf(body);
    const { treeOid } = tipTree(repo, branch);
    const files = flattenTree(repo, treeOid);
    const existing = files.get(path);
    if (existing === undefined) throw new HttpError(404, 'Not Found');
    if (body.sha !== existing.oid) {
      throw new HttpError(409, 'Conflict: sha does not match');
    }
    files.delete(path);
    const commitSha = commitFiles(
      repo,
      branch,
      files,
      typeof body.message === 'string' ? body.message : 'Delete ' + path,
    );
    ctx.json(200, { content: null, commit: { sha: commitSha } });
  });

  router.add('GET', '/api/v3/repos/{owner}/{repo}/commits', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const shaParam = ctx.query.get('sha');
    let start: string | undefined;
    if (shaParam !== null && shaParam !== '') {
      const branchTipSha = repo.refs.get('refs/heads/' + shaParam);
      if (branchTipSha !== undefined) {
        start = branchTipSha;
      } else if (/^[0-9a-f]{40}$/.test(shaParam) && repo.objects.get(shaParam)?.type === 'commit') {
        start = shaParam;
      }
    }
    if (start === undefined) start = branchTip(repo, DEFAULT_BRANCH);
    if (start === undefined) {
      ctx.json(200, []);
      return;
    }

    const rawPer = Number.parseInt(ctx.query.get('per_page') ?? '', 10);
    const perPage = Number.isNaN(rawPer) || rawPer < 1 ? 30 : rawPer;
    const rawPage = Number.parseInt(ctx.query.get('page') ?? '', 10);
    const page = Number.isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
    const need = page * perPage;

    const ordered: string[] = [];
    const visited = new Set<string>();
    const stack = [start];
    while (stack.length > 0 && ordered.length < need) {
      const sha = stack.pop()!;
      if (visited.has(sha)) continue;
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') continue;
      visited.add(sha);
      ordered.push(sha);
      const c = parseCommit(obj.data);
      for (let i = c.parents.length - 1; i >= 0; i--) stack.push(c.parents[i]);
    }

    const slice = ordered.slice((page - 1) * perPage, page * perPage);
    ctx.json(
      200,
      slice.map((sha) => {
        const obj = repo.objects.get(sha)!;
        const c = parseCommit(obj.data);
        return {
          sha,
          commit: {
            message: c.message,
            author: identJson(c.author),
            committer: identJson(c.committer),
            tree: { sha: c.tree },
          },
          parents: c.parents.map((p) => ({ sha: p })),
        };
      }),
    );
  });
}

function listTree(repo: RepoRec, treeOid: string, prefix: string) {
  const obj = repo.objects.get(treeOid);
  const entries = obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries.map((e) => {
    const isTree = e.mode === '40000';
    const target = repo.objects.get(e.oid);
    const size = !isTree && target !== undefined ? target.data.length : 0;
    return {
      type: isTree ? 'dir' : 'file',
      name: e.name,
      path: prefix === '' ? e.name : prefix + '/' + e.name,
      sha: e.oid,
      size,
    };
  });
}

function identJson(line: string): { name: string; email: string; date: string } {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (m !== null) {
    const epoch = Number.parseInt(m[3], 10);
    const date = Number.isNaN(epoch) ? new Date(0).toISOString() : new Date(epoch * 1000).toISOString();
    return { name: m[1], email: m[2], date };
  }
  return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: new Date(0).toISOString() };
}
