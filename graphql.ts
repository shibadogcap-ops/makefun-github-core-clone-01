// GraphQL endpoint: a small executor for the fixed document family that
// gh / github-mcp-server style clients send. No schema, no npm deps.

import {
  branchTip,
  DEFAULT_BRANCH,
  getRepo,
  globalId,
  parseGlobalId,
  store,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { addCommentRec, createIssueRec } from './issues.ts';
import { createPullRec, mergeBase, mergePullRec, prFiles } from './pulls.ts';
import { flattenTree, parseCommit } from './gitobj.ts';
import { type Ctx, type Router } from './app.ts';

// ---------- parser ----------

type Tok = { t: 'name' | 'str' | 'int' | 'punct' | 'eof'; v: string | number };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      toks.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= src.length) throw new Error('Syntax error: unterminated string');
        const ch = src[j];
        if (ch === '"') {
          j += 1;
          break;
        }
        if (ch === '\\') {
          const e = src[j + 1];
          if (e === 'u') {
            const hex = src.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('Syntax error: bad unicode escape');
            out += String.fromCharCode(parseInt(hex, 16));
            j += 6;
            continue;
          }
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
          if (e === undefined || !(e in map)) throw new Error('Syntax error: bad escape');
          out += map[e];
          j += 2;
          continue;
        }
        out += ch;
        j += 1;
      }
      toks.push({ t: 'str', v: out });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      toks.push({ t: 'int', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (src.startsWith('...', i)) {
      toks.push({ t: 'punct', v: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![=.'.includes(c)) {
      toks.push({ t: 'punct', v: c });
      i += 1;
      continue;
    }
    throw new Error(`Syntax error: unexpected character '${c}'`);
  }
  toks.push({ t: 'eof', v: '' });
  return toks;
}

// A GraphQL value as parsed: scalars, arrays, plain objects, or { __gqlVar: name }.
type GVal = unknown;

interface Field {
  alias?: string;
  name: string;
  args: Record<string, GVal>;
  sel?: Sel[];
}
type Sel =
  | { kind: 'field'; field: Field }
  | { kind: 'inline'; typeName?: string; sel: Sel[] }
  | { kind: 'spread'; name: string };

interface Op {
  kind: 'query' | 'mutation';
  name?: string;
  sel: Sel[];
}
interface Frag {
  typeName: string;
  sel: Sel[];
}
interface Doc {
  ops: Op[];
  fragments: Map<string, Frag>;
}

class Parser {
  pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  peek(): Tok {
    return this.toks[this.pos];
  }
  peekAt(n: number): Tok {
    return this.toks[this.pos + n] ?? this.toks[this.toks.length - 1];
  }
  next(): Tok {
    return this.toks[this.pos++];
  }
  isName(v?: string): boolean {
    const t = this.peek();
    return t.t === 'name' && (v === undefined || t.v === v);
  }
  atPunct(v: string): boolean {
    const t = this.peek();
    return t.t === 'punct' && t.v === v;
  }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.t !== 'punct' || t.v !== v) throw new Error(`Syntax error: expected '${v}'`);
  }
  expectName(): string {
    const t = this.next();
    if (t.t !== 'name') throw new Error('Syntax error: expected name');
    return t.v as string;
  }

  document(): Doc {
    const ops: Op[] = [];
    const fragments = new Map<string, Frag>();
    while (this.peek().t !== 'eof') {
      if (this.isName('query') || this.isName('mutation')) {
        const kind = this.next().v as 'query' | 'mutation';
        ops.push(this.operation(kind));
      } else if (this.isName('fragment')) {
        this.next();
        const name = this.expectName();
        if (!this.isName('on')) throw new Error('Syntax error: expected on');
        this.next();
        const typeName = this.expectName();
        fragments.set(name, { typeName, sel: this.selectionSet() });
      } else if (this.atPunct('{')) {
        ops.push({ kind: 'query', sel: this.selectionSet() });
      } else {
        throw new Error('Syntax error: expected operation or fragment');
      }
    }
    if (ops.length === 0) throw new Error('Syntax error: document has no operations');
    return { ops, fragments };
  }

  operation(kind: 'query' | 'mutation'): Op {
    const op: Op = { kind, sel: [] };
    if (this.peek().t === 'name') op.name = this.expectName();
    if (this.atPunct('(')) this.variableDefs();
    op.sel = this.selectionSet();
    return op;
  }

  // Parse and discard variable definitions: ($x: Type!, $y: Int = 3)
  variableDefs(): void {
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.typeRef();
      if (this.atPunct('=')) {
        this.next();
        this.value();
      }
      if (!this.atPunct(')')) throw new Error('Syntax error: expected )');
    }
    this.expectPunct(')');
  }

  typeRef(): void {
    this.expectName();
    for (;;) {
      if (this.atPunct('!')) {
        this.next();
        continue;
      }
      if (this.atPunct('[')) {
        let depth = 0;
        do {
          const t = this.next();
          if (t.t === 'punct' && t.v === '[') depth += 1;
          else if (t.t === 'punct' && t.v === ']') depth -= 1;
          else if (t.t === 'eof') throw new Error('Syntax error: unterminated type');
        } while (depth > 0);
        continue;
      }
      return;
    }
  }

  selectionSet(): Sel[] {
    this.expectPunct('{');
    const out: Sel[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().t === 'eof') throw new Error('Syntax error: unterminated selection set');
      out.push(this.selection());
    }
    this.expectPunct('}');
    return out;
  }

  selection(): Sel {
    if (this.atPunct('...')) {
      this.next();
      if (this.isName('on')) {
        this.next();
        const typeName = this.expectName();
        return { kind: 'inline', typeName, sel: this.selectionSet() };
      }
      if (this.atPunct('{')) return { kind: 'inline', sel: this.selectionSet() };
      return { kind: 'spread', name: this.expectName() };
    }
    return { kind: 'field', field: this.field() };
  }

  field(): Field {
    let alias: string | undefined;
    let name: string;
    const t = this.peek();
    if (t.t === 'name') {
      const after = this.peekAt(1);
      if (after.t === 'punct' && after.v === ':') {
        alias = t.v as string;
        this.next();
        this.next();
        name = this.expectName();
      } else {
        this.next();
        name = t.v as string;
      }
    } else {
      throw new Error('Syntax error: expected field name');
    }
    const f: Field = { name, args: {} };
    if (alias !== undefined) f.alias = alias;
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const key = this.peek().t === 'str' ? (this.next().v as string) : this.expectName();
        this.expectPunct(':');
        f.args[key] = this.value();
        if (!this.atPunct(')')) throw new Error('Syntax error: expected )');
      }
      this.expectPunct(')');
    }
    if (this.atPunct('{')) f.sel = this.selectionSet();
    return f;
  }

  value(): GVal {
    const t = this.next();
    if (t.t === 'str') return t.v;
    if (t.t === 'int') return Number(t.v);
    if (t.t === 'punct' && t.v === '$') return { __gqlVar: this.expectName() };
    if (t.t === 'punct' && t.v === '[') {
      const arr: GVal[] = [];
      while (!this.atPunct(']')) {
        if (this.peek().t === 'eof') throw new Error('Syntax error: unterminated list');
        arr.push(this.value());
        if (!this.atPunct(']')) throw new Error('Syntax error: expected ]');
      }
      this.expectPunct(']');
      return arr;
    }
    if (t.t === 'punct' && t.v === '{') {
      const obj: Record<string, GVal> = {};
      while (!this.atPunct('}')) {
        if (this.peek().t === 'eof') throw new Error('Syntax error: unterminated object');
        const key = this.peek().t === 'str' ? (this.next().v as string) : this.expectName();
        this.expectPunct(':');
        obj[key] = this.value();
        if (!this.atPunct('}')) throw new Error('Syntax error: expected }');
      }
      this.expectPunct('}');
      return obj;
    }
    if (t.t === 'name') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      return t.v; // enum
    }
    throw new Error('Syntax error: expected value');
  }
}

function parseDocument(src: string): Doc {
  return new Parser(tokenize(src)).document();
}

// ---------- runtime values ----------

type V = Record<string, unknown> | unknown[] | string | number | boolean | null;

function repoVal(repo: RepoRec): V {
  return { __type: 'Repository', repo };
}
function issueVal(repo: RepoRec, issue: IssueRec): V {
  return { __type: 'Issue', repo, issue };
}
function pullVal(repo: RepoRec, pull: PullRec): V {
  return { __type: 'PullRequest', repo, pull };
}
function commentVal(repo: RepoRec, comment: { idNum: number; body: string; createdAt: string }): V {
  return { __type: 'IssueComment', repo, comment };
}
function userVal(login: string): V {
  return { __type: 'User', login };
}

const VIEWER: V = { __type: 'User', login: VIEWER_LOGIN };

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
function cursorOfNumber(n: number): string {
  return b64(`cursor:${n}`);
}
function decodeCursor(s: string): number | null {
  try {
    const text = Buffer.from(s, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice(7));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
function cursorOfNode(n: unknown): string | null {
  if (n !== null && typeof n === 'object' && !Array.isArray(n)) {
    const o = n as Record<string, unknown>;
    if (o.__type === 'Issue') return cursorOfNumber((o.issue as IssueRec).number);
    if (o.__type === 'PullRequest') return cursorOfNumber((o.pull as PullRec).number);
    if (o.__type === 'IssueComment') return cursorOfNumber((o.comment as { idNum: number }).idNum);
  }
  return null;
}

// ---------- lookups ----------

function repoByIdNum(idNum: number): RepoRec | null {
  for (const r of store.repos.values()) if (r.idNum === idNum) return r;
  return null;
}

function repoByGlobalId(id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const p = parseGlobalId(id);
  if (p === null || p.kind !== 'Repository') return null;
  const n = Number(p.key);
  return Number.isFinite(n) ? repoByIdNum(n) : null;
}

function issueByGlobalId(id: unknown): { repo: RepoRec; issue: IssueRec } | null {
  if (typeof id !== 'string') return null;
  const p = parseGlobalId(id);
  if (p === null || p.kind !== 'Issue') return null;
  const i = p.key.lastIndexOf(':');
  if (i < 0) return null;
  const repo = repoByIdNum(Number(p.key.slice(0, i)));
  const issue = repo?.issues.get(Number(p.key.slice(i + 1)));
  return repo !== null && repo !== undefined && issue !== undefined ? { repo, issue } : null;
}

function pullByGlobalId(id: unknown): { repo: RepoRec; pull: PullRec } | null {
  if (typeof id !== 'string') return null;
  const p = parseGlobalId(id);
  if (p === null || p.kind !== 'PullRequest') return null;
  const i = p.key.lastIndexOf(':');
  if (i < 0) return null;
  const repo = repoByIdNum(Number(p.key.slice(0, i)));
  const pull = repo?.pulls.get(Number(p.key.slice(i + 1)));
  return repo !== null && repo !== undefined && pull !== undefined ? { repo, pull } : null;
}

function nodeById(id: unknown): V {
  if (typeof id !== 'string') return null;
  const p = parseGlobalId(id);
  if (p === null) return null;
  if (p.kind === 'Repository') {
    const n = Number(p.key);
    const repo = Number.isFinite(n) ? repoByIdNum(n) : null;
    return repo === null ? null : repoVal(repo);
  }
  if (p.kind === 'Issue' || p.kind === 'PullRequest') {
    const found = p.kind === 'Issue' ? issueByGlobalId(id) : pullByGlobalId(id);
    if (found === null) return null;
    return p.kind === 'Issue'
      ? issueVal(found.repo, (found as { issue: IssueRec }).issue)
      : pullVal(found.repo, (found as { pull: PullRec }).pull);
  }
  return null;
}

// ---------- connections ----------

function connValue(
  type: string,
  edgeType: string,
  nodes: V[],
  total: number,
  endCursor: string | null,
  hasNextPage: boolean,
): V {
  return { __type: type, edgeType, nodes, total, endCursor, hasNextPage };
}

function issueConnection(repo: RepoRec, args: Record<string, unknown>): V {
  let items = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states)) {
    const want = new Set(states.map((s) => String(s).toUpperCase()));
    items = items.filter((i) => want.has(i.state.toUpperCase()));
  }
  const ob = args.orderBy;
  const dir =
    ob !== null && typeof ob === 'object' && (ob as Record<string, unknown>).direction === 'ASC'
      ? 'asc'
      : 'desc';
  items.sort((a, b) => (dir === 'asc' ? a.number - b.number : b.number - a.number));
  const total = items.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const n = decodeCursor(args.after);
    if (n !== null) {
      const idx = items.findIndex((i) => i.number === n);
      start = idx === -1 ? 0 : idx + 1;
    }
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : undefined;
  const page = first === undefined ? items.slice(start) : items.slice(start, start + first);
  const nodes = page.map((i) => issueVal(repo, i));
  const last = page[page.length - 1];
  return connValue(
    'IssueConnection',
    'IssueEdge',
    nodes,
    total,
    last === undefined ? null : cursorOfNumber(last.number),
    first !== undefined && start + first < total,
  );
}

function pullConnection(repo: RepoRec, args: Record<string, unknown>): V {
  const items = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
  const total = items.length;
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : undefined;
  const page = first === undefined ? items : items.slice(0, first);
  const nodes = page.map((p) => pullVal(repo, p));
  const last = page[page.length - 1];
  return connValue(
    'PullRequestConnection',
    'PullRequestEdge',
    nodes,
    total,
    last === undefined ? null : cursorOfNumber(last.number),
    first !== undefined && first < total,
  );
}

function commentConnection(repo: RepoRec, comments: { idNum: number; body: string; createdAt: string }[]): V {
  const nodes = comments.map((c) => commentVal(repo, c));
  const last = comments[comments.length - 1];
  return connValue(
    'IssueCommentConnection',
    'IssueCommentEdge',
    nodes,
    comments.length,
    last === undefined ? null : cursorOfNumber(last.idNum),
    false,
  );
}

// ---------- mergeability ----------

function commitFiles(repo: RepoRec, sha: string): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(obj.data).tree);
}

function mergeable(repo: RepoRec, pull: PullRec): string {
  if (pull.state !== 'open' || pull.merged) return 'UNKNOWN';
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef) ?? pull.createdHeadSha;
  if (baseTip === undefined) return 'UNKNOWN';
  const baseSha = mergeBase(repo, baseTip, headTip) ?? baseTip;
  const baseFiles = commitFiles(repo, baseSha);
  const oursFiles = commitFiles(repo, baseTip);
  const theirsFiles = commitFiles(repo, headTip);
  const paths = new Set<string>([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid;
    const o = oursFiles.get(path)?.oid;
    const t = theirsFiles.get(path)?.oid;
    if (o === t) continue;
    if (b === o || b === t) continue;
    return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function commitConnection(repo: RepoRec, pull: PullRec, args: Record<string, unknown>): V {
  const start = branchTip(repo, pull.headRef) ?? pull.createdHeadSha;
  const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : 100;
  const shas: string[] = [];
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0 && shas.length < first) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(sha);
    shas.push(sha);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return connValue(
    'CommitConnection',
    'CommitEdge',
    shas.map((oid) => ({ __type: 'Commit', oid })),
    shas.length,
    null,
    false,
  );
}

// ---------- introspection ----------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'stateReason', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'createdAt', 'updatedAt', 'url', 'repository', 'mergeCommit', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name'],
};
const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
};

function typeInfo(name: unknown): V {
  if (typeof name !== 'string') return null;
  const fields = TYPE_FIELDS[name];
  if (fields !== undefined) return { __type: 'TypeInfo', name, kind: 'OBJECT', fields };
  const enums = TYPE_ENUMS[name];
  if (enums !== undefined) return { __type: 'TypeInfo', name, kind: 'ENUM', enumValues: enums };
  return null;
}

// ---------- field tables ----------

type Resolver = (v: any, args: Record<string, unknown>) => V;
type FieldTable = Record<string, Resolver>;

function connTable(): FieldTable {
  return {
    nodes: (v) => v.nodes,
    edges: (v) =>
      (v.nodes as V[]).map((n) => ({ __type: v.edgeType, node: n, cursor: cursorOfNode(n) })),
    pageInfo: (v) => ({
      __type: 'PageInfo',
      hasNextPage: v.hasNextPage === true,
      endCursor: v.endCursor ?? null,
      hasPreviousPage: false,
      startCursor: v.endCursor ?? null,
    }),
    totalCount: (v) => v.total ?? (Array.isArray(v.nodes) ? v.nodes.length : 0),
  };
}

const FIELDS: Record<string, FieldTable> = {
  Query: {
    viewer: () => VIEWER,
    repository: (_v, args) => {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = getRepo(owner, name);
      return repo === undefined ? null : repoVal(repo);
    },
    node: (_v, args) => nodeById(args.id),
    __type: (_v, args) => typeInfo(args.name),
  },
  Mutation: {
    createIssue: (_v, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(input.repositoryId);
      if (repo === null) throw new Error('Repository not found');
      const title = input.title;
      if (typeof title !== 'string' || title === '') throw new Error('title is required');
      const issue = createIssueRec(repo, {
        title,
        body: typeof input.body === 'string' ? input.body : undefined,
      });
      return { __type: 'CreateIssuePayload', issue: issueVal(repo, issue) };
    },
    closeIssue: (_v, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(input.issueId);
      if (found === null) throw new Error('Issue not found');
      found.issue.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: issueVal(found.repo, found.issue) };
    },
    createPullRequest: (_v, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(input.repositoryId);
      if (repo === null) throw new Error('Repository not found');
      const head = input.headRefName;
      const base = input.baseRefName;
      const title = input.title;
      if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string' || title === '') {
        throw new Error('headRefName, baseRefName and title are required');
      }
      const pull = createPullRec(repo, {
        head,
        base,
        title,
        body: typeof input.body === 'string' ? input.body : undefined,
      });
      return { __type: 'CreatePullRequestPayload', pullRequest: pullVal(repo, pull) };
    },
    mergePullRequest: (_v, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullByGlobalId(input.pullRequestId);
      if (found === null) throw new Error('Pull request not found');
      mergePullRec(found.repo, found.pull); // HttpError propagates -> GraphQL error + null
      return { __type: 'MergePullRequestPayload', pullRequest: pullVal(found.repo, found.pull) };
    },
    addComment: (_v, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(input.subjectId);
      if (found === null) throw new Error('Issue not found');
      const body = input.body;
      if (typeof body !== 'string') throw new Error('body is required');
      const comment = addCommentRec(found.repo, found.issue, body);
      return {
        __type: 'AddCommentPayload',
        commentEdge: { __type: 'CommentEdge', node: commentVal(found.repo, comment), cursor: cursorOfNumber(comment.idNum) },
      };
    },
  },
  User: {
    id: () => globalId('User', String(VIEWER_ID)),
    login: (v) => v.login ?? VIEWER_LOGIN,
    name: () => VIEWER_NAME,
  },
  Repository: {
    id: (v) => globalId('Repository', String(v.repo.idNum)),
    databaseId: (v) => v.repo.idNum,
    name: (v) => v.repo.name,
    nameWithOwner: (v) => `${v.repo.owner}/${v.repo.name}`,
    owner: (v) => userVal(v.repo.owner),
    description: (v) => v.repo.description,
    isPrivate: (v) => v.repo.isPrivate,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    createdAt: (v) => v.repo.createdAt,
    updatedAt: (v) => v.repo.createdAt,
    url: (v) => `https://forge.invalid/${v.repo.owner}/${v.repo.name}`,
    defaultBranchRef: (v) => {
      const tip = branchTip(v.repo, DEFAULT_BRANCH);
      return tip === undefined ? null : { __type: 'Ref', name: DEFAULT_BRANCH };
    },
    issue: (v, args) => {
      const n = Number(args.number);
      const issue = Number.isFinite(n) ? v.repo.issues.get(n) : undefined;
      return issue === undefined ? null : issueVal(v.repo, issue);
    },
    issues: (v, args) => issueConnection(v.repo, args),
    pullRequest: (v, args) => {
      const n = Number(args.number);
      const pull = Number.isFinite(n) ? v.repo.pulls.get(n) : undefined;
      return pull === undefined ? null : pullVal(v.repo, pull);
    },
    pullRequests: (v, args) => pullConnection(v.repo, args),
  },
  Issue: {
    id: (v) => globalId('Issue', `${v.repo.idNum}:${v.issue.number}`),
    number: (v) => v.issue.number,
    title: (v) => v.issue.title,
    body: (v) => v.issue.body,
    state: (v) => v.issue.state.toUpperCase(),
    labels: (v) => (v.issue.labels as string[]).map((name) => ({ __type: 'Label', name })),
    createdAt: (v) => v.issue.createdAt,
    updatedAt: (v) => v.issue.createdAt,
    author: (v) => userVal(v.repo.owner),
    repository: (v) => repoVal(v.repo),
    comments: (v, args) => {
      const all = commentConnection(v.repo, v.issue.comments);
      const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : undefined;
      if (first !== undefined && first < (all.nodes as V[]).length) {
        const nodes = (all.nodes as V[]).slice(0, first);
        return connValue('IssueCommentConnection', 'IssueCommentEdge', nodes, (all.total as number), null, false);
      }
      return all;
    },
  },
  PullRequest: {
    id: (v) => globalId('PullRequest', `${v.repo.idNum}:${v.pull.number}`),
    number: (v) => v.pull.number,
    title: (v) => v.pull.title,
    body: (v) => v.pull.body,
    state: (v) => (v.pull.merged ? 'MERGED' : v.pull.state === 'closed' ? 'CLOSED' : 'OPEN'),
    merged: (v) => v.pull.merged,
    mergedAt: (v) => v.pull.mergedAt,
    mergeable: (v) => mergeable(v.repo, v.pull),
    stateReason: () => null,
    headRefName: (v) => v.pull.headRef,
    baseRefName: (v) => v.pull.baseRef,
    headRef: (v) => ({ __type: 'Ref', name: v.pull.headRef }),
    baseRef: (v) => ({ __type: 'Ref', name: v.pull.baseRef }),
    files: (v, args) => {
      const files = prFiles(v.repo, v.pull);
      const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : files.length;
      return connValue(
        'PullRequestFileConnection',
        'ChangedFileEdge',
        files.slice(0, first).map((f) => ({ __type: 'ChangedFile', path: f.filename })),
        files.length,
        null,
        false,
      );
    },
    commits: (v, args) => commitConnection(v.repo, v.pull, args),
    mergeCommit: (v) =>
      v.pull.mergeCommitSha === null ? null : { __type: 'Commit', oid: v.pull.mergeCommitSha },
    createdAt: (v) => v.pull.createdAt,
    updatedAt: (v) => v.pull.createdAt,
    url: (v) => `https://forge.invalid/${v.repo.owner}/${v.repo.name}/pull/${v.pull.number}`,
    repository: (v) => repoVal(v.repo),
    author: (v) => userVal(v.repo.owner),
  },
  Ref: { name: (v) => v.name },
  Label: { name: (v) => v.name },
  ChangedFile: { path: (v) => v.path },
  Commit: {
    oid: (v) => v.oid,
    abbreviatedOid: (v) => String(v.oid).slice(0, 7),
  },
  IssueComment: {
    id: (v) => globalId('IssueComment', `${v.repo.idNum}:${v.comment.idNum}`),
    body: (v) => v.comment.body,
    createdAt: (v) => v.comment.createdAt,
  },
  CommentEdge: {
    node: (v) => v.node,
    cursor: (v) => v.cursor ?? cursorOfNode(v.node),
  },
  PageInfo: {
    hasNextPage: (v) => v.hasNextPage === true,
    endCursor: (v) => v.endCursor ?? null,
    hasPreviousPage: () => false,
    startCursor: (v) => v.startCursor ?? v.endCursor ?? null,
  },
  TypeInfo: {
    name: (v) => v.name,
    kind: (v) => v.kind,
    description: () => null,
    fields: (v) =>
      Array.isArray(v.fields) ? (v.fields as string[]).map((n) => ({ __type: 'FieldInfo', name: n })) : null,
    enumValues: (v) =>
      Array.isArray(v.enumValues) ? (v.enumValues as string[]).map((n) => ({ __type: 'EnumInfo', name: n })) : null,
    inputFields: () => null,
    interfaces: () => [],
    possibleTypes: () => null,
    ofType: () => null,
  },
  FieldInfo: {
    name: (v) => v.name,
    description: () => null,
    args: () => [],
    type: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  EnumInfo: {
    name: (v) => v.name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  CreateIssuePayload: { issue: (v) => v.issue },
  CloseIssuePayload: { issue: (v) => v.issue },
  CreatePullRequestPayload: { pullRequest: (v) => v.pullRequest },
  MergePullRequestPayload: { pullRequest: (v) => v.pullRequest },
  AddCommentPayload: { commentEdge: (v) => v.commentEdge },
};

for (const t of [
  'IssueConnection',
  'PullRequestConnection',
  'IssueCommentConnection',
  'PullRequestFileConnection',
  'CommitConnection',
]) {
  FIELDS[t] = connTable();
}

// ---------- execution ----------

function substVars(v: unknown, vars: Record<string, unknown>): unknown {
  if (v !== null && typeof v === 'object') {
    if (Array.isArray(v)) return v.map((x) => substVars(x, vars));
    if ('__gqlVar' in (v as Record<string, unknown>)) {
      return vars[(v as Record<string, unknown>).__gqlVar as string] ?? null;
    }
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = substVars(val, vars);
    return o;
  }
  return v;
}

function runtimeType(v: unknown): string | null {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const t = (v as Record<string, unknown>).__type;
    if (typeof t === 'string') return t;
  }
  return null;
}

interface ExecCtx {
  doc: Doc;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function expand(sels: Sel[], typeName: string, ctx: ExecCtx, seen: Set<string>): Field[] {
  const out: Field[] = [];
  for (const s of sels) {
    if (s.kind === 'field') {
      out.push(s.field);
    } else if (s.kind === 'inline') {
      if (s.typeName === undefined || s.typeName === typeName) {
        out.push(...expand(s.sel, typeName, ctx, seen));
      }
    } else {
      const frag = ctx.doc.fragments.get(s.name);
      if (frag !== undefined && !seen.has(s.name) && frag.typeName === typeName) {
        const ns = new Set(seen);
        ns.add(s.name);
        out.push(...expand(frag.sel, typeName, ctx, ns));
      }
    }
  }
  return out;
}

function applySelection(value: V, sels: Sel[], ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((el) => applySelection(el as V, sels, ctx));
  const typeName = runtimeType(value);
  if (typeName === null) return null;
  const fields = expand(sels, typeName, ctx, new Set());
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (f.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const table = FIELDS[typeName];
    const res = table?.[f.name];
    if (res === undefined) {
      out[key] = null;
      ctx.errors.push({ message: `Field '${f.name}' doesn't exist on type '${typeName}'` });
      continue;
    }
    const args = substVars(f.args, ctx.variables) as Record<string, unknown>;
    let raw: V;
    try {
      raw = res(value, args);
    } catch (err) {
      out[key] = null;
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    out[key] = f.sel !== undefined && f.sel.length > 0 ? applySelection(raw, f.sel, ctx) : raw;
  }
  return out;
}

// ---------- operation entry ----------

function runOperation(opBody: unknown): Record<string, unknown> {
  const fail = (message: string): Record<string, unknown> => ({ errors: [{ message }] });
  if (opBody === null || typeof opBody !== 'object' || Array.isArray(opBody)) {
    return fail('Expected an operation object');
  }
  const op = opBody as Record<string, unknown>;
  const query = op.query;
  if (typeof query !== 'string') return fail('Missing query');

  let doc: Doc;
  try {
    doc = parseDocument(query);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(msg.startsWith('Syntax error') ? msg : `Syntax error: ${msg}`);
  }

  let selected: Op | undefined;
  const opName = op.operationName;
  if (typeof opName === 'string' && opName !== '') {
    selected = doc.ops.find((o) => o.name === opName);
    if (selected === undefined) return fail(`Unknown operation "${opName}"`);
  } else {
    selected = doc.ops[0];
  }

  const variables =
    op.variables !== null && typeof op.variables === 'object' && !Array.isArray(op.variables)
      ? (op.variables as Record<string, unknown>)
      : {};
  const ctx: ExecCtx = { doc, variables, errors: [] };
  const root: V = { __type: selected.kind === 'mutation' ? 'Mutation' : 'Query' };
  const data = applySelection(root, selected.sel, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export function registerGraphql(router: Router): void {
  router.add('POST', '/api/graphql', (ctx: Ctx) => {
    const body = ctx.jsonBody();
    if (Array.isArray(body)) {
      ctx.json(200, body.map((op) => runOperation(op)));
    } else {
      ctx.json(200, runOperation(body));
    }
  });
}
