// door.mjs: Proteus on the pharos. This app knows ONLY the pharos. It does not import, call or name any sibling repo; what other repos produce it reads by
// cell and kind (never by author: `by` is provenance, not dispatch), and what it does it weaves as entries.
// The pharos library is not copied here: it is loaded through the pinned pointer in door/pharos.json, whose sha256 must match the library file, or nothing
// is loaded. door/holon.json declares what Proteus reads (ground: placement) and writes (pattern: vfile, vfile-check; out: vfile).
//   which pharos:  --pharos <folder> > $PHAROS > ~/.pharos/proteus. One file per writer, so merge is a union and needs no lock.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto"; import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), DOOR = path.join(HERE, "..", "door");
export const INSTRUMENT = "proteus@0.1.0";
/** what Proteus WRITES. Cells are operator x grain (pharos/cells.json). `placement` is Slate's kind, `vfile-pin` and `vfile-evict` are EODB's: read, never declared here. */
export const KINDS = { vfile: "SYN·Pattern", "vfile-check": "EVA·Pattern", "vfile-evicted": "REC·Figure" };
export class DoorError extends Error { constructor(code, message, extra = {}) { super(message); this.name = "DoorError"; this.code = code; Object.assign(this, extra); } }
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const slugWriter = (by) => String(by || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

/** the pharos library via the door's pinned pointer. Throws DoorError with the fix when it cannot be trusted. */
export async function loadLib(doorDir = DOOR) {
  let ptr; try { ptr = JSON.parse(fs.readFileSync(path.join(doorDir, "pharos.json"), "utf8")); } catch { throw new DoorError("pharos_not_installed", `no pharos door in ${doorDir}. Install it: node <pharos>/bin/pharos.mjs install pharos-core --target "${doorDir}" --apply`); }
  if (ptr.kind !== "pharos-pointer" || !ptr.lib || !ptr.sha256) throw new DoorError("pharos_bad_pointer", "pharos.json is not a pharos pointer");
  const lib = path.resolve(doorDir, ptr.lib); let buf; try { buf = fs.readFileSync(lib); } catch { throw new DoorError("pharos_missing", `the pinned library ${lib} is not there (the pointer is relative to ${doorDir})`); }
  if (sha(buf) !== ptr.sha256) throw new DoorError("pharos_drift", `the pharos library at ${lib} changed since this door was installed (sha256 mismatch). Review the change, then re-run install`, { expected: ptr.sha256, found: sha(buf) });
  return { P: await import(pathToFileURL(lib).href), lib, sha256: ptr.sha256 };
}
export const pharosDir = (arg, env = process.env) => { const v = arg || env.PHAROS || "proteus"; return /[\\/]/.test(v) || v.startsWith("~") ? path.resolve(v.replace(/^~/, os.homedir())) : path.join(os.homedir(), ".pharos", v); };

/** a connection to one pharos folder, with one handle per author */
export class Pharos {
  constructor({ dir, lib, doorDir = DOOR }) { this.dir = dir; this.name = path.basename(dir); this.L = lib; this.doorDir = doorDir; this.handles = new Map(); this.declared = false; this.holon = JSON.parse(fs.readFileSync(path.join(doorDir, "holon.json"), "utf8")); }
  handle(by) { const w = slugWriter(by || "proteus"); if (!this.handles.has(w)) this.handles.set(w, this.L.P.open(this.name, { dir: this.dir, writer: w })); return this.handles.get(w); }
  reader() { return this.L.P.open(this.name, { dir: this.dir, writer: "proteus-reader", frame: false }); }
  exists() { return fs.existsSync(this.dir); }
  /** declare our kinds and holon, once. A kind another repo declared with a different cell is reported, never overwritten. */
  declare() {
    if (this.declared) return this.declaredInfo;
    const h = this.handle("proteus"), g = this.L.P.ground(h), have = new Map(g.kinds.map((k) => [k.name, k.cell])), info = { declared: [], conflicts: [] };
    for (const [kind, cell] of Object.entries(KINDS)) {
      if (have.has(kind)) { if (have.get(kind) !== cell) info.conflicts.push({ kind, ours: cell, theirs: have.get(kind) }); continue; }
      this.L.P.weave(h, { cell: "DEF·Figure", kind: "kind", addr: `kind:${kind}`, body: { name: kind, cell }, basis: { instrument: INSTRUMENT } }); info.declared.push(kind);
    }
    if (!g.holons.some((x) => x.name === this.holon.name && JSON.stringify([x.ground, x.figure, x.pattern, x.out]) === JSON.stringify([this.holon.ground, this.holon.figure, this.holon.pattern, this.holon.out]))) this.L.P.weave(h, { cell: "DEF·Pattern", kind: "holon", addr: `holon:${this.holon.name}`, body: this.holon, basis: { instrument: INSTRUMENT } });
    this.declared = true; this.declaredInfo = info; return info;
  }
  /** weave one step as an entry. `of` cites the entries it read or answers. basis records the instrument and schema version. */
  weave(by, kind, addr, body, of = []) {
    if (!KINDS[kind]) throw new DoorError("bad_args", `proteus writes these kinds: ${Object.keys(KINDS).join(", ")}`);
    this.declare(); const e = this.L.P.weave(this.handle(by), { cell: KINDS[kind], kind, addr, body, of: [...new Set(of)], basis: { instrument: INSTRUMENT, schema: `proteus/${kind}@1` } }); return { id: e.id, kind, addr };
  }
  /** retract entries by weaving (never erase): the ids stop being live in every fold, and the retraction says why */
  retract(by, ids, body) {
    if (!ids.length) return null; this.declare();
    const e = this.L.P.weave(this.handle(by), { cell: "NUL·Figure", kind: "retract", addr: `retract:${sha([...ids].sort().join(",")).slice(0, 16)}`, body, of: [...new Set(ids)], basis: { instrument: INSTRUMENT } });
    return { id: e.id, retracted: ids.length };
  }
  /** pointers by cell, kind or addr (never author): the live entries, retractions applied */
  fold({ cell, kind, addr, limit = 30 } = {}) {
    const f = this.L.P.fold(this.reader(), { cell, kind, addr }), n = Math.max(1, Math.min(+limit || 30, 200));
    return { pharos: this.name, matched: f.entries.length, conflicts: f.conflicts.length ? f.conflicts.slice(0, 20) : [], entries: f.entries.slice(-n) };
  }
  entry(id) { const e = this.L.P.entries(this.reader()).find((x) => x.id === id || x.id.startsWith(id)); if (!e) throw new DoorError("no_entry", `no pharos entry ${id}`); return e; }
}
