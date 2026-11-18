// Pull requests: create, list, get, file diffs and squash merge.

import {
  allocIdNum,
  branchTip,
  pullJson,
  tickEpochSec,
  tickIso,
  type PullRec,
  type RepoRec,
} from './store.ts';
import {
  buildCommitData,
  buildTreeFromFiles,
  flattenTree,
  identLine,
  parseCommit,
  storeObject,
} from './gitobj.ts';
import { HttpError, type Ctx, type Router } from './app.ts';
import { mustRepo } from './repos.ts';

export function normalizeBranch(name: string): string {
  let s = name;
  const i = s.lastIndexOf(':');
  if (i !== -1) s = s.slice(i + 1);
  if (s.startsWith('refs/heads/')) s = s.slice('refs/heads/'.length);
  return s;
}

function commitTree(repo: RepoRec, sha: string): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(obj.data).tree);
}

export function createPullRec(
  repo: RepoRec,
  input: { head: string; base: string; title: string; body?: string },
): PullRec {
  const headRef = normalizeBranch(input.head);
  const baseRef = normalizeBranch(input.base);
  const headSha = branchTip(repo, headRef);
  const baseSha = branchTip(repo, baseRef);
  if (headSha === undefined || baseSha === undefined) {
    throw new HttpError(422, 'Validation Failed: head or base branch does not exist');
  }
  const pull: PullRec = {
    idNum: allocIdNum(),
    number: repo.nextNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef,
    baseRef,
    createdHeadSha: headSha,
    createdBaseSha: baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    comments: [],
    createdAt: tickIso(),
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

export function mergeBase(repo: RepoRec, a: string, b: string): string | undefined {
  const ancestors = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (ancestors.has(sha)) continue;
    ancestors.add(sha);
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancestors.has(sha)) return sha;
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return undefined;
}

function linesOf(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function blobLines(repo: RepoRec, oid: string): string[] {
  const obj = repo.objects.get(oid);
  return obj === undefined ? [] : linesOf(obj.data.toString('utf8'));
}

function lcsLength(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

export function prFiles(
  repo: RepoRec,
  pull: PullRec,
): Array<{ filename: string; status: 'added' | 'modified' | 'deleted'; additions: number; deletions: number; changes: number }> {
  const headTip = branchTip(repo, pull.headRef) ?? pull.createdHeadSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.createdBaseSha;
  const baseSha = mergeBase(repo, baseTip, headTip) ?? baseTip;
  const baseFiles = commitTree(repo, baseSha);
  const headFiles = commitTree(repo, headTip);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const sorted = [...paths].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const out: Array<{ filename: string; status: 'added' | 'modified' | 'deleted'; additions: number; deletions: number; changes: number }> = [];
  for (const filename of sorted) {
    const b = baseFiles.get(filename);
    const h = headFiles.get(filename);
    if (b === undefined && h === undefined) continue;
    if (b === undefined) {
      const additions = blobLines(repo, h!.oid).length;
      out.push({ filename, status: 'added', additions, deletions: 0, changes: additions });
    } else if (h === undefined) {
      const deletions = blobLines(repo, b.oid).length;
      out.push({ filename, status: 'deleted', additions: 0, deletions, changes: deletions });
    } else if (b.oid !== h.oid) {
      const headLines = blobLines(repo, h.oid);
      const baseLines = blobLines(repo, b.oid);
      const lcs = lcsLength(headLines, baseLines);
      const additions = headLines.length - lcs;
      const deletions = baseLines.length - lcs;
      out.push({ filename, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

export function mergePullRec(repo: RepoRec, pull: PullRec): { sha: string } {
  if (pull.state !== 'open' || pull.merged) {
    throw new HttpError(405, 'Pull Request is not mergeable');
  }
  const baseTip = branchTip(repo, pull.baseRef);
  if (baseTip === undefined) {
    throw new HttpError(405, 'Pull Request is not mergeable');
  }
  const headTip = branchTip(repo, pull.headRef) ?? pull.createdHeadSha;
  const baseSha = mergeBase(repo, baseTip, headTip) ?? baseTip;
  const baseFiles = commitTree(repo, baseSha);
  const oursFiles = commitTree(repo, baseTip);
  const theirsFiles = commitTree(repo, headTip);

  const paths = new Set<string>([
    ...baseFiles.keys(),
    ...oursFiles.keys(),
    ...theirsFiles.keys(),
  ]);
  const result = new Map<string, string>();
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid;
    const o = oursFiles.get(path)?.oid;
    const t = theirsFiles.get(path)?.oid;
    let r: string | undefined;
    if (o === t) r = o;
    else if (b === o) r = t;
    else if (b === t) r = o;
    else throw new HttpError(405, 'Pull Request is not mergeable');
    if (r !== undefined) result.set(path, r);
  }

  const resultTree = buildTreeFromFiles(repo, result);
  const now = tickEpochSec();
  const ident = identLine(now);
  const data = buildCommitData({
    tree: resultTree,
    parents: [baseTip],
    author: ident,
    committer: identLine(tickEpochSec()),
    message: `${pull.title} (#${pull.number})`,
  });
  const commitSha = storeObject(repo, 'commit', data);
  repo.refs.set('refs/heads/' + pull.baseRef, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = tickIso();
  pull.mergeCommitSha = commitSha;
  return { sha: commitSha };
}

function getPull(repo: RepoRec, number: number): PullRec {
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new HttpError(404, 'Not Found');
  return pull;
}

export function registerPulls(router: Router): void {
  router.add('POST', '/api/v3/repos/{owner}/{repo}/pulls', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const body = ctx.jsonBody() as Record<string, unknown>;
    if (typeof body.title !== 'string' || body.title === '') {
      throw new HttpError(422, 'Validation Failed: title is required');
    }
    if (typeof body.head !== 'string' || typeof body.base !== 'string') {
      throw new HttpError(422, 'Validation Failed: head and base are required');
    }
    const pull = createPullRec(repo, {
      head: body.head,
      base: body.base,
      title: body.title,
      body: typeof body.body === 'string' ? body.body : undefined,
    });
    ctx.json(201, pullJson(repo, pull));
  });

  router.add('GET', '/api/v3/repos/{owner}/{repo}/pulls', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const stateParam = ctx.query.get('state') ?? 'open';
    const rawPer = Number.parseInt(ctx.query.get('per_page') ?? '', 10);
    let perPage = Number.isNaN(rawPer) ? 30 : rawPer;
    if (perPage < 1) perPage = 1;
    if (perPage > 100) perPage = 100;
    const rawPage = Number.parseInt(ctx.query.get('page') ?? '', 10);
    const page = Number.isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;

    let all = [...repo.pulls.values()];
    if (stateParam === 'open') all = all.filter((p) => p.state === 'open' && !p.merged);
    else if (stateParam === 'closed') all = all.filter((p) => p.state === 'closed' || p.merged);
    all.sort((a, b) => b.number - a.number);
    const slice = all.slice((page - 1) * perPage, page * perPage);
    ctx.json(200, slice.map((p) => pullJson(repo, p)));
  });

  router.add('GET', '/api/v3/repos/{owner}/{repo}/pulls/{number}', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    ctx.json(200, pullJson(repo, getPull(repo, Number(ctx.params.number))));
  });

  router.add('GET', '/api/v3/repos/{owner}/{repo}/pulls/{number}/files', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    ctx.json(200, prFiles(repo, getPull(repo, Number(ctx.params.number))));
  });

  router.add('PUT', '/api/v3/repos/{owner}/{repo}/pulls/{number}/merge', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const pull = getPull(repo, Number(ctx.params.number));
    if (ctx.rawBody.length > 0) ctx.jsonBody();
    const { sha } = mergePullRec(repo, pull);
    ctx.json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
  });
}
