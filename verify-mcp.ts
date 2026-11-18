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

async function mcp(body: unknown, auth = true) {
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}

async function api(method: string, path: string) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

let id = 0;
function call(method: string, params?: unknown) {
  id += 1;
  return { jsonrpc: '2.0', id, method, params };
}

let r = await mcp(call('server/discover'));
check('discover status', r.status === 200, r.status);
check('discover versions', r.json?.result?.supportedVersions?.includes('2026-07-28'), r.json);
check('discover serverInfo', typeof r.json?.result?.serverInfo?.name === 'string' && r.json.result.serverInfo.name.length > 0, r.json);
check('discover tools cap', r.json?.result?.capabilities?.tools !== undefined, r.json);

r = await mcp(call('initialize', { protocolVersion: '2025-11-25' }));
check('initialize echoes', r.json?.result?.protocolVersion === '2025-11-25', r.json);
check('initialize serverInfo', r.json?.result?.serverInfo?.name === 'forge-mcp', r.json);

const t1 = await mcp(call('tools/list'));
const t2 = await mcp(call('tools/list'));
check('tools/list identical', t1.text === t2.text);
const tools = t1.json?.result?.tools;
check('tools count', Array.isArray(tools) && tools.length === 6, tools?.length);
check('tools have desc+schema', tools?.every((t: any) => typeof t.description === 'string' && t.description.length > 0 && t.inputSchema?.type === 'object' && t.inputSchema?.properties), tools);

r = await mcp(call('tools/call', { name: 'create_repo', arguments: { name: 'm1' } }));
check('create_repo ok', r.json?.result?.isError === false, r.json);
const mcpRepoId = r.json?.result?.structuredContent?.id;
const rest = await api('GET', '/api/v3/repos/adaiversen/m1');
check('rest repo 200 same id', rest.status === 200 && rest.json?.id === mcpRepoId, { status: rest.status, id: rest.json?.id, mcpRepoId });

r = await mcp(call('tools/call', { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'm1', title: 'hello' } }));
check('create_issue ok', r.json?.result?.isError === false, r.json);
const restIssues = await api('GET', '/api/v3/repos/adaiversen/m1/issues?state=all');
check('rest lists issue', Array.isArray(restIssues.json) && restIssues.json.some((i: any) => i.title === 'hello'), restIssues.json);

r = await mcp(call('tools/call', { name: 'nope', arguments: {} }));
check('unknown tool -32602', r.status === 200 && r.json?.error?.code === -32602, r.json);

r = await mcp(call('tools/call', { name: 'create_issue', arguments: {} }));
check('missing arg isError', r.json?.result?.isError === true && r.json?.result?.content?.[0]?.text === 'missing required argument: owner', r.json);

r = await mcp('{not json');
check('parse error 400', r.status === 400 && r.json?.error?.code === -32700, { status: r.status, json: r.json });

r = await mcp(call('tools/call', { name: 'get_repo', arguments: { owner: 'adaiversen', repo: 'm1' } }), false);
check('no auth 401', r.status === 401, r.status);

r = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
check('notification 202', r.status === 202, r.status);

r = await mcp([call('ping'), call('server/discover')]);
check('batch 200 array', r.status === 200 && Array.isArray(r.json) && r.json.length === 2, r.json);

r = await mcp(call('bogus/method'));
check('method not found', r.json?.error?.code === -32601, r.json);

server.close();
process.exit(failures === 0 ? 0 : 1);
