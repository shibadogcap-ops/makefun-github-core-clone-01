// Git smart-HTTP protocol layer: pkt-line framing, ref advertisements and the
// v2 ls-refs command. Pure protocol code; routes live in registerGit below.

import { DEFAULT_BRANCH, getRepo, type RepoRec } from './store.ts';
import { parseTag } from './gitobj.ts';
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
    if (first === undefined || !first.payload.toString('utf8').startsWith('command=ls-refs')) {
      ctx.send(501, 'not implemented yet', 'text/plain');
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
