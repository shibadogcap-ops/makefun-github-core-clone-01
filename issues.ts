import {
  allocIdNum,
  issueJson,
  tickIso,
  VIEWER_ID,
  VIEWER_LOGIN,
  type CommentRec,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { HttpError, type Ctx, type Router } from './app.ts';
import { mustRepo } from './repos.ts';

export function createIssueRec(
  repo: RepoRec,
  input: { title: string; body?: string; labels?: string[] },
): IssueRec {
  const labels = input.labels ?? [];
  for (const name of labels) {
    if (!repo.labels.has(name)) {
      throw new HttpError(422, 'Validation Failed: one or more labels do not exist');
    }
  }
  const issue: IssueRec = {
    idNum: allocIdNum(),
    number: repo.nextNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels,
    comments: [],
    createdAt: tickIso(),
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function addCommentRec(repo: RepoRec, item: IssueRec | PullRec, body: string): CommentRec {
  const c: CommentRec = { idNum: allocIdNum(), body, createdAt: tickIso() };
  item.comments.push(c);
  return c;
}

export function commentJson(c: CommentRec) {
  return {
    id: c.idNum,
    body: c.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: c.createdAt,
  };
}

function getIssue(repo: RepoRec, number: number): IssueRec {
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new HttpError(404, 'Not Found');
  return issue;
}

function getCommentable(repo: RepoRec, number: number): IssueRec | PullRec {
  const item = repo.issues.get(number) ?? repo.pulls.get(number);
  if (item === undefined) throw new HttpError(404, 'Not Found');
  return item;
}

function labelJson(l: LabelRec) {
  return { name: l.name, color: l.color, description: l.description };
}

export function registerIssues(router: Router): void {
  router.add('POST', '/api/v3/repos/{owner}/{repo}/labels', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const body = ctx.jsonBody() as Record<string, unknown>;
    const name = body.name;
    if (typeof name !== 'string' || name === '') {
      throw new HttpError(422, 'Validation Failed: name is required');
    }
    const existing = repo.labels.get(name);
    if (existing !== undefined) {
      existing.color = typeof body.color === 'string' ? body.color : existing.color;
      if (typeof body.description === 'string') existing.description = body.description;
      ctx.json(201, labelJson(existing));
      return;
    }
    const label: LabelRec = {
      name,
      color: typeof body.color === 'string' ? body.color : 'ededed',
      description: typeof body.description === 'string' ? body.description : '',
    };
    repo.labels.set(name, label);
    ctx.json(201, labelJson(label));
  });

  router.add('GET', '/api/v3/repos/{owner}/{repo}/labels', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const all = [...repo.labels.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(labelJson);
    ctx.json(200, all);
  });

  router.add('POST', '/api/v3/repos/{owner}/{repo}/issues', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const body = ctx.jsonBody() as Record<string, unknown>;
    const title = body.title;
    if (typeof title !== 'string' || title === '') {
      throw new HttpError(422, 'Validation Failed: title is required');
    }
    const labels = body.labels === undefined ? undefined : body.labels;
    if (labels !== undefined && !Array.isArray(labels)) {
      throw new HttpError(422, 'Validation Failed: labels must be an array');
    }
    const issue = createIssueRec(repo, {
      title,
      body: typeof body.body === 'string' ? body.body : undefined,
      labels: labels as string[] | undefined,
    });
    ctx.json(201, issueJson(repo, issue));
  });

  router.add('GET', '/api/v3/repos/{owner}/{repo}/issues', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const stateParam = ctx.query.get('state') ?? 'open';
    const direction = ctx.query.get('direction') === 'asc' ? 'asc' : 'desc';
    const rawPer = Number.parseInt(ctx.query.get('per_page') ?? '', 10);
    let perPage = Number.isNaN(rawPer) ? 30 : rawPer;
    if (perPage < 1) perPage = 1;
    if (perPage > 100) perPage = 100;
    const rawPage = Number.parseInt(ctx.query.get('page') ?? '', 10);
    const page = Number.isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;

    let all = [...repo.issues.values()];
    if (stateParam === 'open') all = all.filter((i) => i.state === 'open');
    else if (stateParam === 'closed') all = all.filter((i) => i.state === 'closed');
    all.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    const slice = all.slice((page - 1) * perPage, page * perPage);
    ctx.json(200, slice.map((i) => issueJson(repo, i)));
  });

  router.add('GET', '/api/v3/repos/{owner}/{repo}/issues/{number}', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    ctx.json(200, issueJson(repo, getIssue(repo, Number(ctx.params.number))));
  });

  router.add('PATCH', '/api/v3/repos/{owner}/{repo}/issues/{number}', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const issue = getIssue(repo, Number(ctx.params.number));
    const body = ctx.jsonBody() as Record<string, unknown>;
    if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (body.labels !== undefined) {
      if (!Array.isArray(body.labels)) {
        throw new HttpError(422, 'Validation Failed: labels must be an array');
      }
      const labels = body.labels as string[];
      for (const name of labels) {
        if (!repo.labels.has(name)) {
          throw new HttpError(422, 'Validation Failed: one or more labels do not exist');
        }
      }
      issue.labels = labels;
    }
    ctx.json(200, issueJson(repo, issue));
  });

  router.add('POST', '/api/v3/repos/{owner}/{repo}/issues/{number}/comments', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const item = getCommentable(repo, Number(ctx.params.number));
    const body = ctx.jsonBody() as Record<string, unknown>;
    if (typeof body.body !== 'string') {
      throw new HttpError(422, 'Validation Failed: body is required');
    }
    const c = addCommentRec(repo, item, body.body);
    ctx.json(201, commentJson(c));
  });

  router.add('GET', '/api/v3/repos/{owner}/{repo}/issues/{number}/comments', (ctx: Ctx) => {
    const repo = mustRepo(ctx.params.owner, ctx.params.repo);
    const item = getCommentable(repo, Number(ctx.params.number));
    ctx.json(200, item.comments.map(commentJson));
  });
}
