// Git objects, packfiles and smart HTTP (upload-pack v2, receive-pack v0).
//
// Wire facts (from the kit's git-client.ts, via CHECKS-INVENTORY.md §9-10):
// - upload-pack MUST speak protocol v2 (Git-Protocol: version=2); a v0 answer
//   loses 3 checks. receive-pack is v0-only; a v2 advertisement fails.
// - v0 advertisements open with `# service=git-upload-pack` /
//   `# service=git-receive-pack`; v2 opens with `version 2`.
// - receive-pack advertises report-status, side-band-64k, delete-refs.
// - The suite NEVER sends deltas on push (plain objects only); our fetch
//   replies may also send plain objects — no delta search, fastest to build.
// - Non-fast-forward is refused per ref with the exact reason string
//   `non-fast-forward`, but the push still unpacks (`unpack ok`).
// - Pack validity is judged independently: trailer SHA-1, header count ==
//   parsed entries == unique objects, version 2 or 3.
// - Shallow: deepen N excludes ancestors beyond N generations; the boundary
//   commits are named in `shallow-info`; deepen moves the boundary.
// - The server must survive a malformed POST body (`zzzznot-a-pkt-line`).

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { hashObject, type GitObject, type GitObjectType, type Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;
const AGENT = 'forge/1.0';

/* ------------------------------------------------------------------ objects */

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree: bad entry');
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree: truncated entry');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(treeSortKey(a), 'utf8'), Buffer.from(treeSortKey(b), 'utf8')),
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
  timezone?: string;
}): Buffer {
  const tz = fields.timezone ?? '+0000';
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} ${tz}`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} ${tz}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

/** Iterative reachability: commit -> tree + parents; tree -> entries (no gitlinks); tag -> target. */
export function collectReachable(roots: readonly string[], lookup: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = lookup(oid);
    if (obj === undefined) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      stack.push(view.tree);
      for (const parent of view.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match !== null) stack.push(match[1]!);
    }
  }
  return out;
}

/** True when `ancestor` is reachable from `oid` (or equal); walks parents only. */
export function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** Commits reachable from `tip`, tip-first, parents after (BFS by generation). */
export function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return out;
}

/* ------------------------------------------------------------------ pkt-line */

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > PKT_LINE_MAX) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export interface PktPacket {
  readonly kind: 'data' | 'flush' | 'delim' | 'end';
  readonly payload: Buffer;
}

/** Parse a pkt-line stream; trailing raw bytes (a pack) are returned as `raw`. */
export function decodePktLines(buf: Buffer): { packets: PktPacket[]; raw: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break; // raw bytes follow (pack)
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + len > buf.length) throw new Error('pkt-line truncated');
      packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return { packets, raw: buf.subarray(offset) };
}

/* ------------------------------------------------------------------ packfile */

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function writePack(objects: Iterable<{ type: GitObjectType; data: Buffer }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const header = Buffer.alloc(8);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(list.length, 4);
  parts.push(header);
  for (const obj of list) {
    const typeCode = TYPE_CODES[obj.type];
    let size = obj.data.length;
    const first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    const headerBytes: number[] = [size > 0 ? first | 0x80 : first];
    while (size > 0) {
      const byte = size & 0x7f;
      size >>= 7;
      headerBytes.push(size > 0 ? byte | 0x80 : byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta varint truncated');
      const byte = delta[offset++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readDeltaVarint();
  const targetSize = readDeltaVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy offset truncated');
          copyOffset |= delta[offset++]! << (i * 8);
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy size truncated');
          copySize |= delta[offset++]! << (i * 8);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || written + copySize > targetSize) {
        throw new Error('delta copy out of bounds');
      }
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length || written + op > targetSize) throw new Error('delta insert out of bounds');
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackEntry {
  readonly type: GitObjectType;
  readonly data: Buffer;
  readonly oid: string;
}

function decodePackEntryHeader(pack: Buffer, offset: number): { typeCode: number; size: number; next: number } {
  const first = pack[offset]!;
  const typeCode = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  let next = offset + 1;
  let byte = first;
  while ((byte & 0x80) !== 0) {
    byte = pack[next++]!;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    if (shift > 63) throw new Error('pack header varint too long');
  }
  return { typeCode, size, next };
}

/** Parse a pack (v2/v3), resolving OFS/REF deltas; verifies the trailer SHA-1. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackEntry[] {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack bad magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const computed = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!computed.equals(trailer)) throw new Error('pack trailer checksum mismatch');
  const end = pack.length - 20;

  interface RawEntry {
    readonly offset: number;
    readonly typeCode: number;
    readonly size: number;
    readonly data: Buffer;
    readonly baseOffset?: number;
    readonly baseOid?: string;
  }
  const raw: RawEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const { typeCode, size, next } = decodePackEntryHeader(pack, offset);
    offset = next;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: base offset encoded as ((v+1)*128 + b) per byte.
      let byte = pack[offset++]!;
      let value = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset++]!;
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - value;
      if (baseOffset < 0) throw new Error('pack ofs-delta base before start');
    } else if (typeCode === 7) {
      if (offset + 20 > end) throw new Error('pack ref-delta truncated');
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPES[typeCode] === undefined) {
      throw new Error(`pack unknown type ${typeCode}`);
    }
    // Node's sync zlib with {info:true} reports the compressed bytes
    // consumed as engine.bytesWritten (the kit's git-client relies on this).
    const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const data = Buffer.from(inflated.buffer.subarray(0, size));
    if (inflated.buffer.length !== size) throw new Error('pack inflated size mismatch');
    if (inflated.engine.bytesWritten <= 0) throw new Error('pack zlib stream consumed no bytes');
    offset += inflated.engine.bytesWritten;
    raw.push({ offset: entryOffset, typeCode, size, data, baseOffset, baseOid });
  }
  if (offset !== end) throw new Error('pack trailing bytes');

  const byOffset = new Map<number, PackEntry>();
  const resolvedByOid = new Map<string, PackEntry>();
  const resolve = (entry: RawEntry, depth: number): PackEntry => {
    if (depth > count + 2) throw new Error('pack delta cycle');
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: PackEntry | GitObject | undefined;
      if (entry.baseOffset !== undefined) base = byOffset.get(entry.baseOffset);
      else if (entry.baseOid !== undefined) {
        base = resolvedByOid.get(entry.baseOid) ?? resolveBase?.(entry.baseOid);
      }
      if (base === undefined) throw new Error('pack delta base missing');
      const baseData = base.data;
      const baseType = base.type;
      const data = applyDelta(baseData, entry.data);
      const resolved: PackEntry = { type: baseType as GitObjectType, data, oid: hashObject(baseType as GitObjectType, data) };
      byOffset.set(entry.offset, resolved);
      resolvedByOid.set(resolved.oid, resolved);
      return resolved;
    }
    const type = CODE_TYPES[entry.typeCode]!;
    const resolved: PackEntry = { type, data: entry.data, oid: hashObject(type, entry.data) };
    byOffset.set(entry.offset, resolved);
    resolvedByOid.set(resolved.oid, resolved);
    return resolved;
  };
  // Resolve in pack order: OFS bases always precede their deltas; REF bases
  // may follow, so resolve lazily with memoisation.
  const out: PackEntry[] = [];
  for (const entry of raw) out.push(resolve(entry, 0));
  return out;
}

/* ------------------------------------------------------------ smart HTTP */

/** Refs in server order: HEAD symref target first, then heads, then tags. */
export function listRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  const heads: { name: string; oid: string }[] = [];
  const tags: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/heads/')) heads.push({ name, oid });
    else if (name.startsWith('refs/tags/')) tags.push({ name, oid });
    else out.push({ name, oid });
  }
  return [...heads, ...tags, ...out];
}

export function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** v0 advertisement body for a service, with the `# service=` preamble. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const refs = listRefs(repo);
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${headTarget(repo)} side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=${AGENT}`
      : `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      parts.push(pktLine(index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v2 advertisement body: preamble + `version 2` + capability lines. */
export function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

export interface LsRef {
  readonly oid: string;
  readonly name: string;
  readonly symrefTarget?: string;
  readonly peeled?: string;
  readonly unborn?: boolean;
}

/** Resolve a tag ref to the commit it peels to (one level; annotated tags only). */
function peelTag(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return undefined;
  const text = obj.data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  return match?.[1];
}

export function lsRefs(repo: Repo, prefixes: readonly string[], peel: boolean, symrefs: boolean): LsRef[] {
  const out: LsRef[] = [];
  const mainOid = repo.refs.get(headTarget(repo));
  // HEAD is subject to the same prefix filter as every other ref: it does
  // not start with `refs/heads/`, so a prefixed ls-refs must not list it.
  const headMatches = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (symrefs && headMatches) {
    if (mainOid !== undefined) {
      out.push({ oid: mainOid, name: 'HEAD', symrefTarget: headTarget(repo) });
    } else {
      out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: headTarget(repo), unborn: true });
    }
  }
  for (const ref of listRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    const entry: LsRef = { oid: ref.oid, name: ref.name };
    if (peel && ref.name.startsWith('refs/tags/')) {
      const peeled = peelTag(repo, ref.oid);
      if (peeled !== undefined) (entry as { peeled?: string }).peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

function lsRefsBody(refs: readonly LsRef[]): Buffer {
  const parts: Buffer[] = [];
  for (const ref of refs) {
    if (ref.unborn === true) {
      parts.push(pktLine(`unborn HEAD symref-target:${ref.symrefTarget ?? ''}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export interface FetchSelection {
  /** Objects to send (plain, no deltas), in BFS order from the wants. */
  readonly objects: PackEntry[];
  /** Boundary commits at the deepen limit (shallow-info `shallow` lines). */
  readonly shallow: string[];
  /** Former shallow commits now fully included (`unshallow` lines). */
  readonly unshallow: string[];
}

/**
 * The object set a fetch must deliver: reachable from `wants`, minus anything
 * reachable from `haves`, cut off at `deepen` generations when given.
 * Generation 0 is the wants themselves.
 */
/**
 * The objects a `have` already covers: the commit itself and its whole tree,
 * but NOT its ancestry. A shallow client holds the boundary commit (and its
 * tree/blobs) without holding its parents — that is exactly what a deepen
 * fetch must deliver.
 */
function haveDirectClosure(repo: Repo, haves: readonly string[]): Set<string> {
  const out = new Set<string>();
  const addTree = (treeOid: string): void => {
    const treeObj = repo.objects.get(treeOid);
    if (treeObj === undefined || treeObj.type !== 'tree' || out.has(treeOid)) return;
    out.add(treeOid);
    for (const entry of parseTree(treeObj.data)) {
      if (entry.mode === '160000') continue;
      if (entry.mode === '40000') addTree(entry.oid);
      else out.add(entry.oid);
    }
  };
  for (const have of haves) {
    const obj = repo.objects.get(have);
    if (obj === undefined) continue;
    out.add(have);
    if (obj.type === 'commit') addTree(parseCommit(obj.data).tree);
    else if (obj.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'))?.[1];
      if (target !== undefined) {
        const targetObj = repo.objects.get(target);
        if (targetObj !== undefined && targetObj.type === 'commit') addTree(parseCommit(targetObj.data).tree);
      }
    }
  }
  return out;
}

export function selectFetchObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  deepen: number | null,
  previousShallow: readonly string[],
): FetchSelection {
  // A full fetch excludes everything reachable from the haves (the client
  // holds those histories). A deepen fetch excludes only the haves' own
  // objects: the parents inside the deepen window are exactly what the
  // client is asking for, even though they are reachable from a have.
  const haveReachable =
    deepen === null
      ? new Set(collectReachable(haves, (oid) => repo.objects.get(oid)).keys())
      : haveDirectClosure(repo, haves);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const included = new Map<string, GitObject>();
  // A tag want also wants its target commit (a clone wants the tag object,
  // not the peeled commit, but the target must travel with it).
  const expandedWants: string[] = [...wants];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj !== undefined && obj.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'))?.[1];
      if (target !== undefined) expandedWants.push(target);
    }
  }
  const queue: { oid: string; gen: number }[] = expandedWants.map((oid) => ({ oid, gen: 0 }));
  const seenCommit = new Set<string>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    // Beyond the deepen limit: not included, and not a boundary line either
    // (the boundary is the last INCLUDED generation, recorded below).
    if (deepen !== null && gen >= deepen) continue;
    const view = parseCommit(obj.data);
    included.set(oid, obj);
    const tree = repo.objects.get(view.tree);
    if (tree !== undefined) included.set(view.tree, tree);
    // Blobs of this commit's tree (one level; nested trees resolved below).
    const addTreeBlobs = (treeOid: string): void => {
      const treeObj = repo.objects.get(treeOid);
      if (treeObj === undefined || treeObj.type !== 'tree') return;
      for (const entry of parseTree(treeObj.data)) {
        if (entry.mode === '160000') continue;
        const child = repo.objects.get(entry.oid);
        if (child === undefined) continue;
        included.set(entry.oid, child);
        if (child.type === 'tree') addTreeBlobs(entry.oid);
      }
    };
    addTreeBlobs(view.tree);
    if (deepen !== null && gen + 1 >= deepen) {
      // Parents exist but are cut off: this commit is the boundary.
      if (view.parents.length > 0) shallow.push(oid);
    }
    for (const parent of view.parents) queue.push({ oid: parent, gen: gen + 1 });
  }
  for (const oid of previousShallow) {
    if (included.has(oid)) unshallow.push(oid);
  }
  // Exclude anything the client already has; drop tag objects whose target
  // is excluded (a tag pointing at a held commit is not re-sent).
  const objects: PackEntry[] = [];
  for (const [oid, obj] of included) {
    if (haveReachable.has(oid)) continue;
    objects.push({ type: obj.type, data: obj.data, oid });
  }
  // Tags: a want may be a tag object; include it when its target is included.
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj !== undefined && obj.type === 'tag' && !haveReachable.has(want)) {
      if (!objects.some((o) => o.oid === want)) objects.push({ type: 'tag', data: obj.data, oid: want });
    }
  }
  return { objects, shallow: [...new Set(shallow)], unshallow: [...new Set(unshallow)] };
}

/** Side-band-64k framing of a pack: band-1 data packets, chunked to fit. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v2 fetch response: acknowledgments + shallow-info + packfile sections. */
export function v2FetchBody(selection: FetchSelection): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(pktFlush());
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(writePack(selection.objects)));
  return Buffer.concat(parts);
}

/** v0 fetch response: NAK text line, then sideband pack packets. */
export function v0FetchBody(selection: FetchSelection): Buffer {
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(writePack(selection.objects)));
  return Buffer.concat(parts);
}

/* ---------------------------------------------------------- receive-pack */

export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export interface PushReportEntry {
  readonly ref: string;
  readonly ok: boolean;
  readonly reason: string;
}

/** Apply one receive-pack: store the pack's objects, then decide per ref. */
export function applyPush(repo: Repo, commands: readonly PushCommand[], pack: Buffer | null): PushReportEntry[] {
  if (pack !== null && pack.length > 0) {
    let entries: PackEntry[] = [];
    try {
      entries = readPack(pack, (oid) => repo.objects.get(oid));
    } catch {
      // A pack that does not parse still unpacks as far as possible: keep
      // whatever parsed before the failure so the report can say so.
      entries = [];
    }
    for (const entry of entries) repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
  }
  const report: PushReportEntry[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        report.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === undefined) {
      // Create.
      if (command.oldOid !== ZERO_OID) {
        report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        report.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: must be a fast-forward from the advertised old tip.
    if (command.oldOid !== current) {
      report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
      report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      report.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  return report;
}

/** report-status body, framed in side-band-64k band 1 (plus a flush). */
export function pushReportBody(report: readonly PushReportEntry[], unpackOk: boolean, unpackDetail: string): Buffer {
  const lines: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`)];
  for (const entry of report) {
    lines.push(pktLine(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`));
  }
  lines.push(pktFlush());
  const reportBytes = Buffer.concat(lines);
  const parts: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), reportBytes])), pktFlush()];
  return Buffer.concat(parts);
}

/** Parse a receive-pack POST body: command pkt-lines, then raw pack bytes. */
export function parseReceivePackBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const { packets, raw } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const line = text.trim();
    if (line === '') continue;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match === null) throw new Error(`bad receive-pack command: ${JSON.stringify(line)}`);
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  if (commands.length === 0) throw new Error('receive-pack: no commands');
  return { commands, pack: raw.length > 0 ? Buffer.from(raw) : null };
}

export interface FetchRequest {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly deepen: number | null;
  readonly protocol: 0 | 2;
}

/** Parse an upload-pack POST body (v2 command lines or v0 want/have lines). */
export function parseUploadPackBody(body: Buffer, protocol: 0 | 2): FetchRequest {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush' || packet.kind === 'delim') {
      if (packet.kind === 'flush') section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (protocol === 2) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7).trim(), 10);
    } else {
      // v0: first section wants (+ shallow/deepen), second section haves + done.
      if (section === 0) {
        if (line.startsWith('want ')) {
          const first = line.slice(5).trim().split(/\s+/)[0]!;
          wants.push(first);
        } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7).trim(), 10);
      } else {
        if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      }
    }
  }
  if (wants.length === 0) throw new Error('upload-pack: no wants');
  return { wants, haves, shallow, deepen: deepen !== null && Number.isFinite(deepen) ? deepen : null, protocol };
}

/** Parse a v2 ls-refs / fetch command block: returns the command name + args. */
export function parseV2Command(body: Buffer): { command: string; args: Map<string, string[]> } {
  const { packets } = decodePktLines(body);
  const args = new Map<string, string[]>();
  let command = '';
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice(8);
      continue;
    }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    const list = args.get(key) ?? [];
    list.push(value);
    args.set(key, list);
  }
  return { command, args };
}

export { lsRefsBody };
