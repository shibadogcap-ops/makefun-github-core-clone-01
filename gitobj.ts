// Pure git object layer: hashing, object (de)serialization, trees, packs and deltas.
// No HTTP, no store mutations beyond repo.objects.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { VIEWER_EMAIL, VIEWER_NAME, type RepoRec } from './store.ts';

export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function storeObject(repo: RepoRec, type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export function identLine(epochSec: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epochSec} +0000`;
}

export function buildCommitData(opts: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const parts: string[] = [`tree ${opts.tree}`];
  for (const p of opts.parents) parts.push(`parent ${p}`);
  parts.push(`author ${opts.author}`);
  parts.push(`committer ${opts.committer}`);
  parts.push('', opts.message);
  return Buffer.from(parts.join('\n'), 'utf8');
}

export function parseCommit(data: Buffer): {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
} {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const headerPart = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerPart.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp === -1) break;
    const mode = data.toString('utf8', pos, sp);
    const nul = data.indexOf(0x00, sp + 1);
    if (nul === -1) break;
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    pos = nul + 21;
  }
  return out;
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = Buffer.from(a.name + (a.mode === '40000' ? '/' : ''), 'utf8');
    const kb = Buffer.from(b.name + (b.mode === '40000' ? '/' : ''), 'utf8');
    return Buffer.compare(ka, kb);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const headerPart = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of headerPart.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
    else if (line.startsWith('tag ')) tag = line.slice(4);
  }
  return { object, type, tag, message };
}

interface DirNode {
  files: Map<string, string>;
  dirs: Map<string, DirNode>;
}

function newDirNode(): DirNode {
  return { files: new Map(), dirs: new Map() };
}

function writeTree(repo: RepoRec, node: DirNode): string {
  const entries: TreeEntry[] = [];
  for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
  for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: writeTree(repo, child) });
  return storeObject(repo, 'tree', buildTreeData(entries));
}

export function buildTreeFromFiles(repo: RepoRec, files: Map<string, string>): string {
  if (files.size === 0) return EMPTY_TREE_OID;
  const root = newDirNode();
  for (const [path, oid] of files) {
    const segs = path.split('/').filter((s) => s !== '');
    if (segs.length === 0) continue;
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      let next = node.dirs.get(segs[i]);
      if (next === undefined) {
        next = newDirNode();
        node.dirs.set(segs[i], next);
      }
      node = next;
    }
    node.files.set(segs[segs.length - 1], oid);
  }
  return writeTree(repo, root);
}

export function flattenTree(repo: RepoRec, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const p = prefix === '' ? e.name : prefix + '/' + e.name;
      if (e.mode === '40000') walk(e.oid, p);
      else out.set(p, { oid: e.oid, mode: e.mode });
    }
  };
  if (treeOid === '' || treeOid === EMPTY_TREE_OID) return out;
  walk(treeOid, '');
  return out;
}

export function treeEntryAt(
  repo: RepoRec,
  treeOid: string,
  path: string,
): { oid: string; mode: string; isTree: boolean } | undefined {
  const segs = path.split('/').filter((s) => s !== '');
  if (segs.length === 0) return undefined;
  let oid = treeOid;
  let mode = '40000';
  for (let i = 0; i < segs.length; i++) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((e) => e.name === segs[i]);
    if (entry === undefined) return undefined;
    oid = entry.oid;
    mode = entry.mode;
    if (i === segs.length - 1) return { oid, mode, isTree: mode === '40000' };
  }
  return undefined;
}

export function reachable(repo: RepoRec, tips: string[]): Set<string> {
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
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

const PACK_TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_TYPE_NAMES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackHeader(type: string, size: number): number[] {
  const code = PACK_TYPE_CODES[type];
  if (code === undefined) throw new Error(`unknown object type: ${type}`);
  const out = [(code << 4) | (size & 0x0f)];
  let rest = size >>> 4;
  let first = out[0];
  if (rest > 0) first |= 0x80;
  out[0] = first;
  while (rest > 0) {
    let b = rest & 0x7f;
    rest >>>= 7;
    if (rest > 0) b |= 0x80;
    out.push(b);
  }
  return out;
}

export function writePack(objects: Array<{ type: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1].writeUInt32BE(2, 0);
  parts[2].writeUInt32BE(objects.length, 0);
  for (const o of objects) {
    parts.push(Buffer.from(writePackHeader(o.type, o.data.length)));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const pos = { v: 0 };
  const readVarint = (): number => {
    let shift = 0;
    let val = 0;
    for (;;) {
      const b = delta[pos.v++];
      val |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return val >>> 0;
  };
  const srcSize = readVarint();
  const targetSize = readVarint();
  void srcSize;
  void targetSize;
  const out: Buffer[] = [];
  while (pos.v < delta.length) {
    const op = delta[pos.v++];
    if (op === 0) throw new Error('invalid delta instruction');
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) off |= delta[pos.v++] << (8 * i);
      }
      for (let i = 0; i < 3; i++) {
        if (op & (1 << (4 + i))) size |= delta[pos.v++] << (8 * i);
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
    } else {
      out.push(delta.subarray(pos.v, pos.v + op));
      pos.v += op;
    }
  }
  return Buffer.concat(out);
}

function inflateEntry(buf: Buffer): { data: Buffer; consumed: number } {
  const r = inflateSync(buf, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: r.buffer, consumed: r.engine.bytesWritten };
}

export function readPack(
  buf: Buffer,
  lookup?: (oid: string) => { type: string; data: Buffer } | undefined,
): Array<{ oid: string; type: string; data: Buffer }> {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'PACK') {
    throw new Error('not a pack file');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const results: Array<{ oid: string; type: string; data: Buffer }> = [];
  const byOffset = new Map<number, { type: string; data: Buffer }>();
  const byOid = new Map<string, { type: string; data: Buffer }>();
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const entryStart = pos;
    let b = buf[pos++];
    const typeCode = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[pos++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    void size;
    let type = PACK_TYPE_NAMES[typeCode];
    let data: Buffer;
    if (typeCode === 6) {
      // OFS_DELTA
      let c = buf[pos++];
      let offset = c & 0x7f;
      while (c & 0x80) {
        c = buf[pos++];
        offset = ((offset + 1) << 7) | (c & 0x7f);
      }
      const base = byOffset.get(entryStart - offset);
      const inflated = inflateEntry(buf.subarray(pos));
      pos += inflated.consumed;
      data = applyDelta(base?.data ?? Buffer.alloc(0), inflated.data);
      type = base?.type ?? 'blob';
    } else if (typeCode === 7) {
      // REF_DELTA
      const baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const base = byOid.get(baseOid) ?? lookup?.(baseOid);
      const inflated = inflateEntry(buf.subarray(pos));
      pos += inflated.consumed;
      data = applyDelta(base?.data ?? Buffer.alloc(0), inflated.data);
      type = base?.type ?? 'blob';
    } else {
      const inflated = inflateEntry(buf.subarray(pos));
      pos += inflated.consumed;
      data = inflated.data;
    }
    const oid = hashObject(type, data);
    const rec = { type, data };
    byOffset.set(entryStart, rec);
    byOid.set(oid, rec);
    results.push({ oid, type, data });
  }
  return results;
}
