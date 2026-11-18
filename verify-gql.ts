import { createApp } from './app.ts';

process.env.MAKEFUN_SHOP_TOKEN = 'test';
const TOKEN = 'test';

const server = createApp();
await new Promise<void>((r) => server.listen(0, () => r()));
const addr = server.address();
if (addr === null || typeof addr === 'string') throw new Error('no addr');
const base = `http://127.0.0.1:${addr.port}`;

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name}`, extra === undefined ? '' : JSON.stringify(extra));
  }
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function gql(body: unknown) {
  const res = await fetch(base + '/api/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// --- setup via REST ---
let r = await api('POST', '/api/v3/user/repos', { name: 'q1', description: 'gql test' });
check('create repo', r.status === 201, r.json);
const repoId = r.json.id;

r = await api('PUT', '/api/v3/repos/adaiversen/q1/contents/a.txt', {
  content: Buffer.from('hello\n').toString('base64'),
  message: 'add a',
});
check('put a.txt on main', r.status === 201, r.json);
const mainTip = r.json.commit.sha;

r = await api('POST', '/api/v3/repos/adaiversen/q1/git/refs', { ref: 'refs/heads/feature', sha: mainTip });
check('create feature branch', r.status === 201, r.json);

r = await api('PUT', '/api/v3/repos/adaiversen/q1/contents/b.txt', {
  content: Buffer.from('world\n').toString('base64'),
  message: 'add b',
  branch: 'feature',
});
check('put b.txt on feature', r.status === 201, r.json);

r = await api('POST', '/api/v3/repos/adaiversen/q1/pulls', { head: 'feature', base: 'main', title: 'add b' });
check('create PR', r.status === 201, r.json);
const prNumber = r.json.number;

// three issues, close one
for (const t of ['issue one', 'issue two', 'issue three']) {
  r = await api('POST', '/api/v3/repos/adaiversen/q1/issues', { title: t });
  check(`create issue ${t}`, r.status === 201, r.json);
}
r = await api('PATCH', '/api/v3/repos/adaiversen/q1/issues/2', { state: 'closed' });
check('close issue 2', r.status === 200, r.json);

// --- GraphQL checks ---
let g = await gql({ query: '{ viewer { login } }' });
check('viewer login', g.status === 200 && g.json.data?.viewer?.login === 'adaiversen', g.json);

const repoFields = `query RepoFields {
  repository(owner: "adaiversen", name: "q1") {
    id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled
  }
}`;
g = await gql({ query: repoFields });
const rf = g.json.data?.repository;
check(
  'repository fields',
  rf?.databaseId === repoId &&
    rf?.name === 'q1' &&
    rf?.owner?.login === 'adaiversen' &&
    rf?.defaultBranchRef?.name === 'main' &&
    rf?.viewerPermission === 'ADMIN' &&
    rf?.hasIssuesEnabled === true &&
    typeof rf?.id === 'string',
  g.json,
);
const repoGid = rf.id;

g = await gql({ query: 'query Issue { __type(name: "Issue") { fields(includeDeprecated: true) { name } } }' });
const fnames = (g.json.data?.__type?.fields ?? []).map((f: any) => f.name);
check(
  'introspect Issue fields',
  ['id', 'number', 'title', 'state', 'body'].every((n) => fnames.includes(n)),
  g.json,
);

const openIssues = `query OpenIssues {
  repository(owner: "adaiversen", name: "q1") {
    issues(states: [OPEN], orderBy: { field: CREATED_AT, direction: DESC }, first: 10) {
      totalCount
      nodes { number state }
    }
  }
}`;
g = await gql({ query: openIssues });
const nodes = g.json.data?.repository?.issues?.nodes ?? [];
check(
  'open issues desc',
  nodes.map((n: any) => n.number).join(',') === '3,1' &&
    nodes.every((n: any) => n.state === 'OPEN') &&
    g.json.data?.repository?.issues?.totalCount === 2,
  g.json,
);

g = await gql({
  query: 'mutation { createIssue(input: { repositoryId: "' + repoGid + '", title: "gql made" }) { issue { number title } } }',
});
const newNum = g.json.data?.createIssue?.issue?.number;
check('createIssue mutation', typeof newNum === 'number', g.json);
if (typeof newNum === 'number') {
  r = await api('GET', `/api/v3/repos/adaiversen/q1/issues/${newNum}`);
  check('REST sees gql issue', r.status === 200 && r.json.title === 'gql made', r.json);
}

g = await gql({ query: '{ viewer { noSuchFieldOnViewer } }' });
check(
  'unknown field error',
  g.status === 200 &&
    Array.isArray(g.json.errors) &&
    g.json.errors[0]?.message?.includes('noSuchFieldOnViewer') &&
    g.json.data?.viewer?.noSuchFieldOnViewer === null,
  g.json,
);

g = await gql({ query: '{ repository(owner: "adaiversen", name: "nope") { id } }' });
check('unknown repo null no errors', g.json.data?.repository === null && !('errors' in g.json), g.json);

const batch = await fetch(base + '/api/graphql', {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify([
    { query: '{ viewer { login } }' },
    { query: 'query Issue { __type(name: "Issue") { fields { name } } }' },
  ]),
});
const batchJson = await batch.json();
check(
  'batched ops',
  Array.isArray(batchJson) &&
    batchJson.length === 2 &&
    batchJson[0]?.data?.viewer?.login === 'adaiversen' &&
    (batchJson[1]?.data?.__type?.fields ?? []).length > 0,
  batchJson,
);

g = await gql({
  query: 'query N($id: ID!) { node(id: $id) { ... on Repository { name nameWithOwner } } }',
  variables: { id: repoGid },
});
check(
  'node(id) round-trip',
  g.json.data?.node?.name === 'q1' && g.json.data?.node?.nameWithOwner === 'adaiversen/q1',
  g.json,
);

// extra sanity: pull request fields + mergeable + files
g = await gql({
  query: `query PR { repository(owner:"adaiversen",name:"q1") { pullRequest(number:${prNumber}) { number state mergeable headRefName baseRefName files(first:5){nodes{path}} } } }`,
});
const pr = g.json.data?.repository?.pullRequest;
check(
  'pullRequest fields',
  pr?.number === prNumber && pr?.state === 'OPEN' && pr?.mergeable === 'MERGEABLE' && pr?.headRefName === 'feature' &&
    (pr?.files?.nodes ?? []).some((f: any) => f.path === 'b.txt'),
  g.json,
);

g = await gql({ query: '{ __type(name: "SearchType") { kind enumValues { name } } }' });
check(
  'SearchType enum',
  g.json.data?.__type?.kind === 'ENUM' &&
    ['ISSUE', 'REPOSITORY', 'USER'].every((n) => (g.json.data.__type.enumValues ?? []).some((e: any) => e.name === n)),
  g.json,
);

server.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
