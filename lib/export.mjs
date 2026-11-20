// export.mjs: write a recipe out as a REAL file, once, for the things that need a path (an editor, an upload dialog, a client). Everything else can stay virtual.
//   proteus export --project P --sequence S --to out.mp4        the live recipe for that sequence (or branch)
//   proteus export --recipe <prefix> --to old.mp4              any recipe ever recorded, including a retracted old version
//   proteus exports [--project P] [--verify]                   what has been written out, whether it is still there, and whether a newer recipe has replaced it
// The file is built from the recorded recipe and checked against what the ledger recorded (size, header hash, and the whole-file hash when one was recorded). A file the ledger would
// call `differs` is refused unless asked for. The bytes are written to a temp file beside the target and renamed into place, so a failure leaves no half-written file; and the write is
// refused up front when the folder cannot hold it. Each export weaves a `vfile-export` entry (REC·Figure) citing the recipe's `vfile` entry: where it went, how big, its sha256, how it
// was verified. Proteus never deletes an exported file: what to keep is EODB's and the person's call, and `exports` is how they find the copies (and which are stale).
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import * as PF from "./pfile.mjs"; import * as VFL from "./vfile.mjs"; import { docProjector, DOC_PROJECTOR } from "./docfold.mjs";

export class ExportError extends Error { constructor(code, message, extra = {}) { super(message); this.name = "ExportError"; this.code = code; Object.assign(this, extra); } }
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const formatOf = (name) => (name === DOC_PROJECTOR ? "docx" : "mp4");
const projectorOf = (ph, name) => (name === DOC_PROJECTOR ? docProjector(ph) : VFL.knownProjector(name) ? VFL.projectorFor(name) : null);

/** the `vfile` entries that record a recipe: the live one for (project, sequence), or every entry for a recipe id prefix (a retracted old version included), latest first, entries that recorded a build before those that did not.
 *  Several can exist for one recipe (the same edit recorded on two machines, with different bytes): an export is accepted if the rebuild matches ANY of them. */
export function findRecipes(ph, { project, sequence, recipe }) {
  if (recipe) {
    const hits = ph.L.P.entries(ph.reader()).filter((e) => e.kind === "vfile" && e.body && typeof e.body.recipe === "string" && e.body.recipe.startsWith(recipe)).reverse();
    if (!hits.length) throw new ExportError("no_recipe", `no recorded recipe starts with ${recipe}`);
    if (new Set(hits.map((e) => e.body.recipe)).size > 1) throw new ExportError("ambiguous", `${recipe} matches more than one recipe: ${[...new Set(hits.map((e) => e.body.recipe.slice(0, 16)))].join(", ")}`);
    return [...hits.filter((e) => e.body.header_sha256 != null), ...hits.filter((e) => e.body.header_sha256 == null)];
  }
  if (!project || !sequence) throw new ExportError("bad_args", "give --project and --sequence, or --recipe");
  const live = PF.live(ph, project, sequence); if (!live.length) throw new ExportError("no_recipe", `no live recipe for ${project}/${sequence}`);
  return [live.at(-1)];
}
export const findRecipe = (ph, q) => findRecipes(ph, q)[0];

/** build the recipe's file, verify it against the ledger, write it atomically to `to`, and weave the `vfile-export` entry. */
export async function exportRecipe(ph, by, { project, sequence, recipe, to, force = false, allowDiffers = false, free = null }) {
  if (!to) throw new ExportError("bad_args", "give --to <path>");
  const dest = path.resolve(to), dir = path.dirname(dest), t0 = Date.now(), cands = findRecipes(ph, { project, sequence, recipe }), body = cands[0].body, proj = projectorOf(ph, body.projector);
  if (!proj) throw new ExportError("unknown_projector", `recipe made by ${body.projector}, which this build does not know`);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new ExportError("no_dir", `${dir} is not a folder`);
  if (fs.existsSync(dest) && (fs.statSync(dest).isDirectory() || !force)) throw new ExportError("exists", `${dest} already exists${fs.statSync(dest).isDirectory() ? " (a folder)" : "; pass --force to replace it"}`);
  const { inputs, missing } = proj.inputsFromBody(body, (id, hint) => hint);
  if (missing.length) throw new ExportError("unavailable", `the recipe's inputs are not all here: ${[...new Set(missing)].slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`, { missing: [...new Set(missing)] });
  const b = await proj.build(inputs, {});
  if (PF.recipeOf(proj, inputs).id !== body.recipe) throw new ExportError("recipe_mismatch", "rebuilding from the recorded inputs gives a different recipe id");
  const recorded = cands.filter((c) => c.body.header_sha256 != null), matches = recorded.filter((c) => b.size === c.body.size && b.header_sha256 === c.body.header_sha256), differs = recorded.length > 0 && matches.length === 0;
  if (differs && !allowDiffers) throw new ExportError("differs", `the rebuilt file is not what the ledger recorded (size ${b.size} vs ${recorded[0].body.size}, header ${String(b.header_sha256).slice(0, 12)} vs ${String(recorded[0].body.header_sha256).slice(0, 12)}${recorded.length > 1 ? `; ${recorded.length} entries record this recipe and none match` : ""}); pass --allow-differs to write it anyway`);
  const avail = free ? free(dir) : (() => { const s = fs.statfsSync(dir); return s.bavail * s.bsize; })(), need = Math.ceil(b.size * 1.05) + (1 << 20);
  if (avail < need) throw new ExportError("no_space", `${dir} has ${avail} bytes free, this file needs about ${need}`, { need, avail });
  const tmp = `${dest}.proteus-${process.pid}.tmp`, h = crypto.createHash("sha256"); let written = 0;
  const fd = fs.openSync(tmp, "wx");
  try {
    const chunks = b.v.bytes ? [b.v.bytes] : VFL.VF.readRange(b.v, 0, b.v.size - 1);
    for (const c of chunks) { h.update(c); let off = 0; while (off < c.length) off += fs.writeSync(fd, c, off, c.length - off); written += c.length; }
    fs.fsyncSync(fd); fs.closeSync(fd);
    if (written !== b.size) throw new ExportError("short_write", `wrote ${written} of ${b.size} bytes`);
    const digest = h.digest("hex"), full = matches.find((c) => c.body.file_sha256 === digest), fileBad = !full && matches.length > 0 && matches.every((c) => c.body.file_sha256 && c.body.file_sha256 !== digest);
    if (fileBad && !allowDiffers) throw new ExportError("differs", `the whole-file hash is not what the ledger recorded (${digest.slice(0, 12)} vs ${matches[0].body.file_sha256.slice(0, 12)})`);
    fs.renameSync(tmp, dest);
    const cite = full || matches[0] || cands[0], verified = differs || fileBad ? "differs" : full ? "file_sha256" : matches.length ? "size+header" : "none";
    const w = ph.weave(by, "vfile-export", `vfile-export:${body.recipe.slice(0, 16)}:${digest.slice(0, 12)}`, { recipe: body.recipe, project: body.project, sequence: body.sequence, format: formatOf(body.projector), path: dest, size: written, sha256: digest, verified }, [cite.id]);
    return { path: dest, size: written, sha256: digest, verified, recipe: body.recipe, format: formatOf(body.projector), id: w.id, ms: Date.now() - t0, chunks_made: b.made || 0, ...(path.extname(dest) === "." + formatOf(body.projector) ? {} : { note: `the file is ${formatOf(body.projector)} but the name does not say so` }) };
  } catch (err) { try { fs.closeSync(fd); } catch { /* already closed */ } fs.rmSync(tmp, { force: true }); throw err; }          // only our own temp file is ever removed
}

/** what has been written out: still there? changed since? replaced by a newer recipe for the same sequence? Reads only; never deletes. */
export function listExports(ph, { project = null, recipe = null, verify = false } = {}) {
  const rows = ph.L.P.fold(ph.reader(), { kind: "vfile-export" }).entries.filter((e) => e.body && (!project || e.body.project === project) && (!recipe || e.body.recipe.startsWith(recipe)));
  return rows.map((e) => {
    const b = e.body; let state; try { const st = fs.statSync(b.path); state = st.size !== b.size ? "changed" : verify ? (sha(fs.readFileSync(b.path)) === b.sha256 ? "present" : "changed") : "present"; } catch { state = "missing"; }
    const cur = PF.live(ph, b.project, b.sequence).at(-1);
    return { id: e.id, path: b.path, size: b.size, state, project: b.project, sequence: b.sequence, recipe: b.recipe.slice(0, 16), format: b.format, verified: b.verified, written: e.at, by: e.by, stale: !!cur && cur.body.recipe !== b.recipe, current_recipe: cur ? cur.body.recipe.slice(0, 16) : null };
  });
}
