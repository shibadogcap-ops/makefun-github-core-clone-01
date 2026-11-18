export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.com';
export const DEFAULT_BRANCH = 'main';

export function trialBaseMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw === undefined) return 1767225600000;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : 1767225600000;
  }
  const t = Date.parse(trimmed);
  return Number.isNaN(t) ? 1767225600000 : t;
}

let tick = 0;

export function tickIso(): string {
  const s = new Date(trialBaseMs() + tick * 1000).toISOString();
  tick += 1;
  return s;
}

export function tickEpochSec(): number {
  const s = Math.floor(trialBaseMs() / 1000) + tick;
  tick += 1;
  return s;
}

export interface GitObjectRec {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

export interface CommentRec {
  idNum: number;
  body: string;
  createdAt: string;
}

export interface IssueRec {
  idNum: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
}

export interface PullRec {
  idNum: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  createdHeadSha: string;
  createdBaseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: CommentRec[];
  createdAt: string;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface RepoRec {
  idNum: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  createdAt: string;
  objects: Map<string, GitObjectRec>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
}

export const store = { repos: new Map<string, RepoRec>(), nextIdNum: 1 };

export function allocIdNum(): number {
  return store.nextIdNum++;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): RepoRec | undefined {
  return store.repos.get(repoKey(owner, name));
}

const DEFAULT_LABELS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'enhancement', color: 'a2eeef' },
  { name: 'documentation', color: '0075ca' },
  { name: 'question', color: 'd876e3' },
  { name: 'good first issue', color: '7057ff' },
  { name: 'help wanted', color: '008672' },
];

export function createRepoRec(name: string, opts: { isPrivate?: boolean; description?: string }): RepoRec {
  const key = repoKey(VIEWER_LOGIN, name);
  if (store.repos.has(key)) throw new Error('name already exists on this account');
  const labels = new Map<string, LabelRec>();
  for (const l of DEFAULT_LABELS) labels.set(l.name, { name: l.name, color: l.color, description: '' });
  const rec: RepoRec = {
    idNum: allocIdNum(),
    name,
    owner: VIEWER_LOGIN,
    isPrivate: opts.isPrivate ?? false,
    description: opts.description ?? '',
    createdAt: tickIso(),
    objects: new Map(),
    refs: new Map(),
    labels,
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
  };
  store.repos.set(key, rec);
  return rec;
}

export function deleteRepoRec(owner: string, name: string): boolean {
  return store.repos.delete(repoKey(owner, name));
}

export function listRepos(): RepoRec[] {
  return [...store.repos.values()].sort((a, b) => a.idNum - b.idNum);
}

export function globalId(kind: string, key: string): string {
  return Buffer.from(kind + ':' + key, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const s = Buffer.from(id, 'base64').toString('utf8');
    const i = s.indexOf(':');
    if (i < 0) return null;
    return { kind: s.slice(0, i), key: s.slice(i + 1) };
  } catch {
    return null;
  }
}

export function defaultBranchOf(_repo: RepoRec): string {
  return DEFAULT_BRANCH;
}

export function branchTip(repo: RepoRec, branch: string): string | undefined {
  return repo.refs.get('refs/heads/' + branch);
}

export function repoJson(r: RepoRec) {
  let openCount = 0;
  for (const i of r.issues.values()) if (i.state === 'open') openCount += 1;
  for (const p of r.pulls.values()) if (p.state === 'open') openCount += 1;
  return {
    id: r.idNum,
    name: r.name,
    full_name: r.owner + '/' + r.name,
    owner: { login: r.owner, id: VIEWER_ID, type: 'User' },
    private: r.isPrivate,
    description: r.description,
    default_branch: 'main',
    created_at: r.createdAt,
    updated_at: r.createdAt,
    html_url: 'https://forge.invalid/' + r.owner + '/' + r.name,
    clone_url: 'https://forge.invalid/' + r.owner + '/' + r.name + '.git',
    has_issues: true,
    has_pull_requests: true,
    open_issues_count: openCount,
  };
}

export function issueJson(r: RepoRec, i: IssueRec) {
  return {
    id: i.idNum,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((name) => ({ name, color: r.labels.get(name)?.color ?? 'ededed' })),
    user: { login: r.owner, id: VIEWER_ID },
    comments: i.comments.length,
    created_at: i.createdAt,
    updated_at: i.createdAt,
    html_url: 'https://forge.invalid/' + r.owner + '/' + r.name + '/issues/' + i.number,
  };
}

export function pullJson(r: RepoRec, p: PullRec) {
  return {
    id: p.idNum,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeCommitSha,
    head: { ref: p.headRef, sha: branchTip(r, p.headRef) ?? p.createdHeadSha, label: r.owner + ':' + p.headRef },
    base: { ref: p.baseRef, sha: branchTip(r, p.baseRef) ?? p.createdBaseSha, label: r.owner + ':' + p.baseRef },
    user: { login: r.owner, id: VIEWER_ID },
    created_at: p.createdAt,
    updated_at: p.createdAt,
    html_url: 'https://forge.invalid/' + r.owner + '/' + r.name + '/pull/' + p.number,
  };
}
