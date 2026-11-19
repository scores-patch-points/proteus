// pfile.mjs: a PROJECTED FILE as entries of a pharos. This is the writer's side of a contract that lives IN THE PHAROS, not in any repo: the shapes of the
// `vfile` and `vfile-check` entries (docs/VFILE.md, "Contract"). Repos never call each other; they write and read entries by cell and kind. So this code is
// Slate's own implementation of writing those entries, kept free of video, ffmpeg and anything else Slate-specific only so that any projector can use it.
// Another repo that wants to write or check such files implements the same shapes itself; it does not import this. Readers (EODB included) ask the
// pharos by kind and need none of this code.
//
// A projector turns inputs into the bytes of a file. This module records, in the pharos, everything those bytes are a function of, and checks it:
//   vfile        SYN·Pattern  the RECIPE: the projector's identity object (its name and version, and every input by content id, never by path), what
//                             building it gave (size, header hash), path hints in `where`. Cites the entries it was made from.
//   vfile-check  EVA·Pattern  a rebuild from the recorded recipe alone, compared with what was recorded: identical | differs | unavailable | recipe_mismatch
//                             | unrecorded. Determinism is measured and recorded, never assumed.
// NOT in the log: the bytes, and any chunks the projector caches. Those are a cache; deleting them costs time only.
//
// A projector is { name, identity(inputs), where(inputs), inputsFromBody(body, resolve) -> {inputs, missing[]}, build(inputs, opts) -> {size, header_sha256,
//   chunks?, file_sha256?, ms?, made?, v?} }. `identity` must include `projector: name`. `ph` is a pharos connection (weave, retract, reader, L.P).
import crypto from "node:crypto";

export const CELLS = { vfile: "SYN·Pattern", "vfile-check": "EVA·Pattern" };
export class VfileError extends Error { constructor(code, message, extra = {}) { super(message); this.name = "VfileError"; this.code = code; Object.assign(this, extra); } }
export const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
export const canon = (v) => JSON.stringify(sortKeys(v));
export const r6 = (x) => Math.round(+x * 1e6) / 1e6;     // numbers as the log will give them back, so a recipe rebuilt from an entry equals the one first made

/** identity by recipe, not path: same inputs by content, same recipe id */
export function recipeOf(projector, inputs) { const identity = projector.identity(inputs); return { id: sha(canon(identity)), identity }; }

// ---- reading the pharos
export const addrOf = (project, sequence) => `vfile:${project}:${sequence}`;
const foldKind = (ph, query) => ph.L.P.fold(ph.reader(), query).entries;
export const live = (ph, project, sequence) => foldKind(ph, { kind: "vfile", addr: addrOf(project, sequence) });
/** the live placement entries a file was made from: what the recipe cites (kind `placement` is the editor's; other callers pass `cite`) */
export const placementIds = (ph, project, sequence) => foldKind(ph, { kind: "placement" }).filter((e) => e.body && e.body.project === project && e.body.sequence === sequence).map((e) => e.id);

const retire = (ph, by, cur, project, sequence) => { const stale = cur.map((e) => e.id); if (stale.length) ph.retract(by, stale, { why: "the file's recipe changed (its inputs moved)", project, sequence }); return stale.length; };

/** weave the recipe. Unchanged recipe and bytes: nothing is woven. A changed recipe retracts the old entry (never erases it) and weaves the new one.
 *  { build: false }: nothing is built and the projector does no work; only the recipe is woven (size and header hash are null until a build records them). */
export async function record(ph, by, { project, sequence, inputs, cite = null }, { projector, build = true, ...opts } = {}) {
  const r = recipeOf(projector, inputs), addr = addrOf(project, sequence), cur = live(ph, project, sequence), where = projector.where(inputs);
  const cites = () => [...new Set(cite || placementIds(ph, project, sequence))];
  if (!build) {
    const out = { recipe: r.id, size: null, frames: r.identity.frames, chunks: null, header_sha256: null, ms: 0, made: 0, built: false };
    const same = cur.find((e) => e.body && e.body.recipe === r.id);
    if (same) return { ...out, size: same.body.size, header_sha256: same.body.header_sha256, chunks: same.body.chunks, built: same.body.header_sha256 != null, unchanged: true, id: same.id, retracted: 0 };
    const retracted = retire(ph, by, cur, project, sequence);
    const w = ph.weave(by, "vfile", addr, { project, sequence, ...r.identity, recipe: r.id, where, size: null, header_sha256: null, chunks: null }, cites());
    return { ...out, unchanged: false, id: w.id, retracted, addr };
  }
  const b = await projector.build(inputs, opts);
  const out = { recipe: r.id, size: b.size, frames: r.identity.frames, chunks: b.chunks, header_sha256: b.header_sha256, ms: b.ms, made: b.made, built: true };
  const same = cur.find((e) => e.body && e.body.recipe === r.id && e.body.header_sha256 === b.header_sha256 && (!b.file_sha256 || e.body.file_sha256 === b.file_sha256));
  if (same) return { ...out, unchanged: true, id: same.id, retracted: 0 };
  const retracted = retire(ph, by, cur, project, sequence);
  const body = { project, sequence, ...r.identity, recipe: r.id, where, size: b.size, header_sha256: b.header_sha256, chunks: b.chunks, ...(b.file_sha256 ? { file_sha256: b.file_sha256 } : {}) };
  const w = ph.weave(by, "vfile", addr, body, cites());
  return { ...out, unchanged: false, id: w.id, retracted, addr };
}

/** rebuild from the recorded recipe alone. `resolve(contentId, hint)` finds a file for a content id (default: the recorded path hint). */
export async function open(ph, { project, sequence }, { projector, resolve = (id, hint) => hint, deep = false, ...opts } = {}) {
  const cur = live(ph, project, sequence); if (!cur.length) throw new VfileError("no_vfile", `no live vfile for ${addrOf(project, sequence)}`);
  const e = cur.at(-1), b0 = e.body, expected = { size: b0.size, header_sha256: b0.header_sha256, ...(b0.file_sha256 ? { file_sha256: b0.file_sha256 } : {}) };
  if (b0.projector !== projector.name) return { status: "recipe_mismatch", entry: e.id, recipe: b0.recipe, recorded_projector: b0.projector, projector: projector.name, expected };
  const { inputs, missing } = projector.inputsFromBody(b0, resolve);
  if (missing.length) return { status: "unavailable", entry: e.id, recipe: b0.recipe, missing: [...new Set(missing)], expected };
  const b = await projector.build(inputs, { deep: deep && !!b0.file_sha256, ...opts }), rid = recipeOf(projector, inputs).id;
  const found = { size: b.size, header_sha256: b.header_sha256, ...(b.file_sha256 ? { file_sha256: b.file_sha256 } : {}) };
  const status = rid !== b0.recipe ? "recipe_mismatch" : b0.header_sha256 == null ? "unrecorded" : found.size === expected.size && found.header_sha256 === expected.header_sha256 && (!found.file_sha256 || found.file_sha256 === expected.file_sha256) ? "identical" : "differs";
  return { status, entry: e.id, recipe: b0.recipe, expected, found, v: b.v, ms: b.ms, made: b.made };
}

/** rebuild and weave the result as evidence */
export async function check(ph, by, { project, sequence }, opts = {}) {
  const r = await open(ph, { project, sequence }, opts);
  const w = ph.weave(by, "vfile-check", `vfile-check:${project}:${sequence}:${r.recipe.slice(0, 16)}`, { project, sequence, recipe: r.recipe, result: r.status, expected: r.expected, ...(r.found ? { found: r.found } : {}), ...(r.missing ? { missing: r.missing } : {}), ...(r.recorded_projector ? { recorded_projector: r.recorded_projector, projector: r.projector } : {}), ...(r.ms !== undefined ? { ms: r.ms, chunks_made: r.made } : {}) }, [r.entry]);
  return { ...r, check: w.id };
}
