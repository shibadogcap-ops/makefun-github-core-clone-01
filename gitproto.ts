// Git smart-HTTP protocol layer: pkt-line framing, ref advertisements and the
// v2 ls-refs command. Pure protocol code; routes live in registerGit below.

import { DEFAULT_BRANCH, getRepo, type RepoRec } from './store.ts';
import { parseCommit, parseTag, parseTree, writePack } from './gitobj.ts';
import type { Ctx, Router } from './app.ts';

export const ZERO_OID = '0'.repeat(40);

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH: Buffer = Buffer.from('0000');
export const PKT_DELIM: Buffer = Buffer.from('0001');

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

export function parsePktLines(buf: Buffer, offset = 0): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) return { packets, rest: Buffer.alloc(0) };
    if (buf.length - pos < 4) throw new Error('truncated pkt-line length');
    const hex = buf.toString('latin1', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`invalid pkt-line length: ${hex}`);
    const len = parseInt(hex, 16);
    pos += 4;
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, rest: buf.subarray(pos) };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      continue;
    }
    if (len === 2) {
      // response-end: treated like a flush for our purposes
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, rest: buf.subarray(pos) };
    }
    if (len < 4) throw new Error(`invalid pkt-line length: ${len}`);
    if (buf.length - pos < len - 4) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buf.subarray(pos, pos + len - 4) });
    pos += len - 4;
  }
}

export function peelToCommit(repo: RepoRec, oid: string): string {
  let cur = oid;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

export function sortedRefNames(repo: RepoRec): string[] {
  return [...repo.refs.keys()].sort();
}

export function headTarget(repo: RepoRec): string {
  void repo;
  return 'refs/heads/' + DEFAULT_BRANCH;
}

export interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

export function refLines(repo: RepoRec, opts: { peel: boolean }): RefLine[] {
  const target = headTarget(repo);
  const tip = repo.refs.get(target);
  const out: RefLine[] = [];
  if (tip === undefined) {
    out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: target, unborn: true });
  } else {
    out.push({ oid: tip, name: 'HEAD', symrefTarget: target });
  }
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    if (opts.peel && repo.objects.get(oid)?.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== oid) line.peeled = peeled;
    }
    out.push(line);
  }
  return out;
}

export function advertisement(ctx: Ctx, repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const proto = ctx.headers['git-protocol'];
  const protoStr = Array.isArray(proto) ? proto.join(',') : (proto ?? '');
  const isV2 = service === 'git-upload-pack' && protoStr.includes('version=2');

  if (isV2) {
    const parts = [
      pktLine('version 2\n'),
      pktLine('agent=forge/1.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ];
    ctx.send(200, Buffer.concat(parts), 'application/x-git-upload-pack-advertisement');
    return;
  }

  const caps =
    service === 'git-upload-pack'
      ? 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=forge/1.0'
      : 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';

  const lines = refLines(repo, { peel: service === 'git-upload-pack' });
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const hasRefs = sortedRefNames(repo).length > 0;

  if (service === 'git-upload-pack') {
    const head = lines[0];
    const refs = lines.slice(1);
    if (head.unborn) {
      if (hasRefs) parts.push(pktLine(`${ZERO_OID} HEAD\0${caps}\n`));
      else parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      parts.push(pktLine(`${head.oid} HEAD\0${caps}\n`));
    }
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      if (r.peeled !== undefined) parts.push(pktLine(`${r.peeled} ${r.name}{}\n`));
    }
  } else {
    const refs = lines.slice(1);
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      parts.push(pktLine(`${refs[0].oid} ${refs[0].name}\0${caps}\n`));
      for (const r of refs.slice(1)) {
        parts.push(pktLine(`${r.oid} ${r.name}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  ctx.send(200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}

// Full object closure with a single cut: a commit whose sha is in stopAt is
// included with its tree closure but its parents are not followed. Trees,
// blobs and tags always expand fully (tags follow to their object).
function closure(repo: RepoRec, tips: string[], stopAt: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (obj === undefined) continue;
    seen.add(sha);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!stopAt.has(sha)) for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

export interface FetchRequest {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth?: number;
}

function commitParents(repo: RepoRec, sha: string): string[] {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return [];
  return parseCommit(obj.data).parents;
}

function commitTree(repo: RepoRec, sha: string): string {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return '';
  return parseCommit(obj.data).tree;
}

function orderSend(repo: RepoRec, set: Set<string>): string[] {
  const groups: Record<string, string[]> = { commit: [], tree: [], blob: [], tag: [] };
  for (const sha of set) {
    const t = repo.objects.get(sha)?.type;
    if (t !== undefined && t in groups) groups[t].push(sha);
  }
  const out: string[] = [];
  for (const t of ['commit', 'tree', 'blob', 'tag']) {
    groups[t].sort();
    out.push(...groups[t]);
  }
  return out;
}

export function planFetch(
  repo: RepoRec,
  req: FetchRequest,
): { send: string[]; shallow: string[]; unshallow: string[] } {
  const clientShallowSet = new Set(req.clientShallow);

  const haveSet = new Set<string>();
  for (const h of req.haves) {
    if (!repo.objects.has(h)) continue;
    for (const s of closure(repo, [h], clientShallowSet)) haveSet.add(s);
  }

  const sendSet = new Set<string>();
  let shallow: string[] = [];
  let unshallow: string[] = [];

  const depth = req.depth;
  if (depth === undefined || depth <= 0) {
    for (const w of req.wants) {
      for (const s of closure(repo, [w], clientShallowSet)) sendSet.add(s);
    }
  } else {
    // Level the commits: BFS from each want's peeled commit. A commit at level
    // L expands to parents at L+1 only while L + 1 < depth, so commits at
    // level depth - 1 are included but not expanded (the shallow boundary).
    const levels = new Map<string, number>();
    const queue: string[] = [];
    for (const w of req.wants) {
      const c = peelToCommit(repo, w);
      if (repo.objects.get(c)?.type === 'commit' && !levels.has(c)) {
        levels.set(c, 0);
        queue.push(c);
      }
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const sha = queue[qi];
      const level = levels.get(sha)!;
      if (level + 1 >= depth) continue;
      for (const p of commitParents(repo, sha)) {
        const pc = peelToCommit(repo, p);
        if (repo.objects.get(pc)?.type === 'commit' && !levels.has(pc)) {
          levels.set(pc, level + 1);
          queue.push(pc);
        }
      }
    }

    const boundary = new Set<string>();
    for (const [sha, level] of levels) {
      if (level === depth - 1 && commitParents(repo, sha).length > 0) boundary.add(sha);
    }

    // Every included commit plus the closure of its tree.
    for (const sha of levels.keys()) {
      sendSet.add(sha);
      const tree = commitTree(repo, sha);
      if (tree !== '') {
        for (const s of closure(repo, [tree], clientShallowSet)) sendSet.add(s);
      }
    }
    // Wants that do not peel to a commit still send their full closure.
    for (const w of req.wants) {
      const c = peelToCommit(repo, w);
      if (repo.objects.get(c)?.type !== 'commit') {
        for (const s of closure(repo, [w], clientShallowSet)) sendSet.add(s);
      }
    }
    // Want tag objects and their peeled chain down to the commit.
    for (const w of req.wants) {
      let cur = w;
      const seen = new Set<string>();
      while (!seen.has(cur)) {
        seen.add(cur);
        const obj = repo.objects.get(cur);
        if (obj === undefined || obj.type !== 'tag') break;
        sendSet.add(cur);
        cur = parseTag(obj.data).object;
      }
    }

    shallow = [...boundary].filter((o) => !clientShallowSet.has(o));
    unshallow = req.clientShallow.filter((o) => levels.has(o) && !boundary.has(o));
  }

  for (const h of haveSet) sendSet.delete(h);
  return { send: orderSend(repo, sendSet), shallow, unshallow };
}

export function isAncestor(repo: RepoRec, anc: string, desc: string): boolean {
  const target = peelToCommit(repo, anc);
  const stack = [peelToCommit(repo, desc)];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(peelToCommit(repo, p));
  }
  return false;
}

function sidebandChunks(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < pack.length; i += 32768) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + 32768)])));
  }
  return out;
}

function packFor(repo: RepoRec, send: string[]): Buffer {
  const objects = send
    .map((sha) => repo.objects.get(sha))
    .filter((o): o is { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer } => o !== undefined);
  return writePack(objects);
}

function firstArgOid(line: string, prefix: string): string | undefined {
  if (!line.startsWith(prefix)) return undefined;
  const rest = line.slice(prefix.length).trim();
  if (rest === '') return undefined;
  return rest.split(/\s+/)[0];
}

function fetchPlanArgs(packets: PktPacket[]): {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth?: number;
  done: boolean;
} {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  const delimIdx = packets.findIndex((p) => p.kind === 'delim');
  const argPackets = delimIdx === -1 ? [] : packets.slice(delimIdx + 1);
  for (const p of argPackets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'done') {
      done = true;
      continue;
    }
    const want = firstArgOid(line, 'want ');
    if (want !== undefined) {
      wants.push(want);
      continue;
    }
    const have = firstArgOid(line, 'have ');
    if (have !== undefined) {
      haves.push(have);
      continue;
    }
    const shallow = firstArgOid(line, 'shallow ');
    if (shallow !== undefined) {
      clientShallow.push(shallow);
      continue;
    }
    if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice('deepen '.length), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // 'deepen-since', 'deepen-not', 'thin-pack', 'ofs-delta',
    // 'no-progress', 'filter ...' and anything else is ignored.
  }
  return { wants, haves, clientShallow, depth, done };
}

function commonHave(repo: RepoRec, haves: string[]): string | undefined {
  for (const h of haves) {
    if (repo.objects.has(h)) return h;
  }
  return undefined;
}

function handleFetchV2(ctx: Ctx, repo: RepoRec, packets: PktPacket[]): void {
  const req = fetchPlanArgs(packets);
  const { done, ...fetchReq } = req;
  const plan = planFetch(repo, fetchReq);
  const have = commonHave(repo, req.haves);

  const parts: Buffer[] = [];

  if (!done) {
    // Negotiation round: the client expects an acknowledgments section. A
    // common have means the pack can be sent now ('ready' + DELIM); without
    // one we NAK and end the response so the client sends more haves.
    parts.push(pktLine('acknowledgments\n'));
    if (have === undefined) {
      parts.push(pktLine('NAK\n'), PKT_FLUSH);
      ctx.send(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    parts.push(pktLine(`ACK ${have}\n`), pktLine('ready\n'), PKT_DELIM);
  }

  if (plan.shallow.length + plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const o of plan.shallow) parts.push(pktLine(`shallow ${o}\n`));
    for (const o of plan.unshallow) parts.push(pktLine(`unshallow ${o}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandChunks(packFor(repo, plan.send)));
  parts.push(PKT_FLUSH);
  ctx.send(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetchV0(ctx: Ctx, repo: RepoRec, parsed: { packets: PktPacket[]; rest: Buffer }): void {
  const wants: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | undefined;
  for (const p of parsed.packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    const want = firstArgOid(line, 'want ');
    if (want !== undefined) {
      wants.push(want);
      continue;
    }
    const shallow = firstArgOid(line, 'shallow ');
    if (shallow !== undefined) {
      clientShallow.push(shallow);
      continue;
    }
    if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice('deepen '.length), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }

  let havePackets: PktPacket[];
  try {
    havePackets = parsePktLines(parsed.rest).packets;
  } catch {
    ctx.send(400, 'invalid pkt-line', 'text/plain');
    return;
  }
  const haves: string[] = [];
  let done = false;
  let haveData = false;
  for (const p of havePackets) {
    if (p.kind !== 'data') continue;
    haveData = true;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'done') {
      done = true;
      continue;
    }
    const have = firstArgOid(line, 'have ');
    if (have !== undefined) haves.push(have);
  }

  const plan = planFetch(repo, { wants, haves, clientShallow, depth });
  const have = commonHave(repo, haves);

  const parts: Buffer[] = [];
  let shallowLines = 0;
  for (const o of plan.shallow) {
    parts.push(pktLine(`shallow ${o}\n`));
    shallowLines += 1;
  }
  for (const o of plan.unshallow) {
    parts.push(pktLine(`unshallow ${o}\n`));
    shallowLines += 1;
  }
  // A shallow list is its own block, terminated by a flush, before the
  // ACK/NAK and pack data (mirrors upload-pack's send_shallow_list).
  if (shallowLines > 0) parts.push(PKT_FLUSH);

  if (!haveData) {
    // Want-section-only request (e.g. the first leg of a v0 deepen fetch):
    // the shallow list is the whole answer.
    if (shallowLines === 0) parts.push(PKT_FLUSH);
    ctx.send(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }

  parts.push(have !== undefined ? pktLine(`ACK ${have}\n`) : pktLine('NAK\n'));
  // The pack goes out once the client says 'done'; mid-negotiation have
  // blocks get just the ACK/NAK and the client sends more haves.
  if (done && plan.send.length > 0) parts.push(...sidebandChunks(packFor(repo, plan.send)));
  parts.push(PKT_FLUSH);
  ctx.send(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

export function registerGit(router: Router): void {
  router.add('GET', '/{owner}/{repo}.git/info/refs', (ctx: Ctx) => {
    const repo = getRepo(ctx.params.owner, ctx.params.repo);
    if (repo === undefined) {
      ctx.json(404, { message: 'Not Found' });
      return;
    }
    const service = ctx.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      ctx.send(403, 'service not available', 'text/plain');
      return;
    }
    advertisement(ctx, repo, service);
  });

  router.add('POST', '/{owner}/{repo}.git/git-upload-pack', (ctx: Ctx) => {
    const repo = getRepo(ctx.params.owner, ctx.params.repo);
    if (repo === undefined) {
      ctx.json(404, { message: 'Not Found' });
      return;
    }

    let parsed: { packets: PktPacket[]; rest: Buffer };
    try {
      parsed = parsePktLines(ctx.rawBody);
    } catch {
      ctx.send(400, 'invalid pkt-line', 'text/plain');
      return;
    }
    const first = parsed.packets.find((p) => p.kind === 'data');
    if (first === undefined) {
      ctx.send(400, 'invalid request', 'text/plain');
      return;
    }
    const head = first.payload.toString('utf8');
    if (head.startsWith('command=fetch')) {
      handleFetchV2(ctx, repo, parsed.packets);
      return;
    }
    if (head.startsWith('want ')) {
      handleFetchV0(ctx, repo, parsed);
      return;
    }
    if (!head.startsWith('command=ls-refs')) {
      ctx.send(400, 'unsupported request', 'text/plain');
      return;
    }

    const delimIdx = parsed.packets.findIndex((p) => p.kind === 'delim');
    const argPackets = delimIdx === -1 ? [] : parsed.packets.slice(delimIdx + 1);
    const args = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
    for (const p of argPackets) {
      if (p.kind !== 'data') continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }

    const out: Buffer[] = [];
    for (const r of refLines(repo, { peel: args.peel })) {
      if (args.prefixes.length > 0 && !args.prefixes.some((p) => r.name.startsWith(p))) continue;
      if (r.name === 'HEAD') {
        if (r.unborn) {
          if (!args.unborn) continue;
          out.push(pktLine(`unborn HEAD${args.symrefs ? ` symref-target:${r.symrefTarget}` : ''}\n`));
        } else {
          out.push(pktLine(`${r.oid} HEAD${args.symrefs ? ` symref-target:${r.symrefTarget}` : ''}\n`));
        }
      } else {
        const peeled = args.peel && r.peeled !== undefined ? ` peeled:${r.peeled}` : '';
        out.push(pktLine(`${r.oid} ${r.name}${peeled}\n`));
      }
    }
    out.push(PKT_FLUSH);
    ctx.send(200, Buffer.concat(out), 'application/x-git-upload-pack-result');
  });
}
