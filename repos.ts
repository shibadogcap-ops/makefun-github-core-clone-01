import {
  createRepoRec,
  deleteRepoRec,
  getRepo,
  listRepos,
  repoKey,
  repoJson,
  store,
  type RepoRec,
} from './store.ts';
import { HttpError, type Ctx, type Router } from './app.ts';

export function mustRepo(owner: string, name: string): RepoRec {
  const repo = getRepo(owner, name);
  if (repo === undefined) throw new HttpError(404, 'Not Found');
  return repo;
}

export function registerRepos(router: Router): void {
  router.add('POST', '/api/v3/user/repos', (ctx: Ctx) => {
    const body = ctx.jsonBody() as Record<string, unknown>;
    const name = body.name;
    if (typeof name !== 'string' || name === '') {
      throw new HttpError(422, 'Validation Failed: name is required');
    }
    let repo: RepoRec;
    try {
      repo = createRepoRec(name, {
        isPrivate: body.private === true,
        description: typeof body.description === 'string' ? body.description : '',
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'name already exists on this account') {
        throw new HttpError(422, 'name already exists on this account');
      }
      throw err;
    }
    ctx.json(201, repoJson(repo));
  });

  router.add('GET', '/api/v3/user/repos', (ctx: Ctx) => {
    const all = listRepos();
    const rawPer = Number.parseInt(ctx.query.get('per_page') ?? '', 10);
    let perPage = Number.isNaN(rawPer) ? 30 : rawPer;
    if (perPage < 1) perPage = 1;
    if (perPage > 100) perPage = 100;
    const rawPage = Number.parseInt(ctx.query.get('page') ?? '', 10);
    const page = Number.isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
    const totalPages = Math.max(1, Math.ceil(all.length / perPage));
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page < totalPages) {
      const host = ctx.headers.host ?? 'localhost';
      const path = ctx.path;
      const last = Math.max(totalPages, page + 1);
      headers.Link =
        `<http://${host}${path}?per_page=${perPage}&page=${page + 1}>; rel="next", ` +
        `<http://${host}${path}?per_page=${perPage}&page=${last}>; rel="last"`;
    }
    ctx.json(200, slice.map(repoJson), headers);
  });

  router.add('GET', '/api/v3/repos/{owner}/{repo}', (ctx: Ctx) => {
    ctx.json(200, repoJson(mustRepo(ctx.params.owner, ctx.params.repo)));
  });

  router.add('PATCH', '/api/v3/repos/{owner}/{repo}', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const body = ctx.jsonBody() as Record<string, unknown>;
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.isPrivate = body.private;
    if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
      const oldOwner = repo.owner;
      const oldName = repo.name;
      store.repos.delete(repoKey(oldOwner, oldName));
      repo.name = body.name;
      store.repos.set(repoKey(oldOwner, repo.name), repo);
    }
    ctx.json(200, repoJson(repo));
  });

  router.add('DELETE', '/api/v3/repos/{owner}/{repo}', (ctx: Ctx) => {
    mustRepo(ctx.params.owner, ctx.params.repo);
    deleteRepoRec(ctx.params.owner, ctx.params.repo);
    ctx.empty(204);
  });

  router.add('POST', '/api/v3/repos/{owner}/{repo}/git/refs', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const body = ctx.jsonBody() as Record<string, unknown>;
    const ref = body.ref;
    if (typeof ref !== 'string' || !ref.startsWith('refs/')) {
      throw new HttpError(422, 'Validation Failed: ref is required');
    }
    const sha = body.sha;
    const obj = typeof sha === 'string' ? repo.objects.get(sha) : undefined;
    if (typeof sha !== 'string' || obj === undefined) {
      throw new HttpError(422, 'Object does not exist');
    }
    repo.refs.set(ref, sha);
    ctx.json(201, { ref, object: { sha, type: obj.type } });
  });

  router.add('GET', '/api/v3/repos/{owner}/{repo}/git/refs/{ref...}', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const fullRef = 'refs/' + ctx.params.ref;
    const sha = repo.refs.get(fullRef);
    if (sha === undefined) throw new HttpError(404, 'Not Found');
    const type = repo.objects.get(sha)?.type ?? 'commit';
    ctx.json(200, { ref: fullRef, object: { sha, type } });
  });

  router.add('GET', '/api/v3/repos/{owner}/{repo}/branches', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    ctx.json(200, branches.map((b) => ({ ...b, protected: false })));
  });

  router.add('GET', '/api/v3/repos/{owner}/{repo}/branches/{branch}', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const sha = repo.refs.get('refs/heads/' + ctx.params.branch);
    if (sha === undefined) throw new HttpError(404, 'Not Found');
    ctx.json(200, { name: ctx.params.branch, commit: { sha } });
  });
}
