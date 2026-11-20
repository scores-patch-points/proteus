// vfile.mjs: Slate's one media projector for projected files: the picture of an edit as a virtual mp4 (lib/vfold.mjs). Video editing only.
// Everything generic (the recipe entries `vfile` / `vfile-check`, identity by recipe, record / open / check, the cache-versus-log rule) is in lib/pfile.mjs,
// which knows nothing of video. This file supplies what only video knows: how clips become a plan, how a plan becomes a header
// over cached all-intra chunks, how to hash it, and how to find the clips again from a recipe's essence ids.
//
//   vfold projector inputs: { clips: [{s, e, in, media (essence id), crop, path}] on one picture track, total: seconds }
import crypto from "node:crypto"; import fs from "node:fs";
import * as VF from "./vfold.mjs"; import * as PF from "./pfile.mjs";
import { VfileError, r6, sha } from "./pfile.mjs";

export const PROJECTOR = `vfold@v${VF.V}`;
export { VfileError, VF };
export const { addrOf, live, placementIds } = PF;
const normalise = (clips) => clips.map((c) => ({ ...c, s: r6(c.s), e: r6(c.e), in: r6(c.in), crop: c.crop || "" }));

/** the file's own bytes, hashed by streaming it (cost: its whole size; only asked for with `deep`) */
export function fileSha256(v) { const h = crypto.createHash("sha256"); for (const b of VF.readRange(v, 0, v.size - 1)) h.update(b); return h.digest("hex"); }

export const vfoldProjector = {
  name: PROJECTOR,
  /** everything the bytes are a function of: clips by essence id and span on the 24 fps grid, crop, frame size, length */
  identity({ clips, total }) {
    const cs = [...clips].sort((a, b) => a.s - b.s || a.e - b.e).map((c) => {
      if (!c.media) throw new VfileError("no_essence", `the clip at ${c.s}s has no essence id (media). A recipe names content, not paths; stamp the project first (slate timeline stamp)`, { at: c.s });
      return { s: r6(c.s), e: r6(c.e), in: r6(c.in), media: c.media, crop: c.crop || "" };
    });
    return { projector: PROJECTOR, fps: VF.FPS, chunk: VF.CHUNK, w: VF.W, h: VF.H, frames: Math.round(total * VF.FPS), clips: cs };
  },
  where({ clips }) { const w = {}; for (const c of clips) if (c.path) w[c.media] ||= c.path; return w; },
  inputsFromBody(body, resolve) {
    const missing = [], clips = body.clips.map((c) => { const p = resolve(c.media, body.where && body.where[c.media]); if (!p || !fs.existsSync(p)) missing.push(c.media); return { ...c, path: p }; });
    return { inputs: { clips, total: body.frames / VF.FPS }, missing };
  },
  /** plan from the normalised clips (so a build from a recorded recipe plans the same frames), make any missing chunk, assemble the header */
  async build({ clips, total }, { workers = 6, onChunk = () => {}, deep = false } = {}) {
    const norm = normalise(clips), v = await VF.vfold(VF.plan(norm, total), { workers, onChunk });
    return { v, size: v.size, frames: v.frames, chunks: v.chunks, header_sha256: sha(v.header), ...(deep ? { file_sha256: fileSha256(v) } : {}), ms: v.ms, made: v.made, clips: norm };
  },
};

// ---- sound clips (the A1 track). When a recipe carries `aclips`, sound comes from them; otherwise from the picture clips.
const normAudio = (aclips) => [...aclips].sort((a, b) => a.s - b.s || a.e - b.e).map((c) => { if (!c.media) throw new VfileError("no_essence", `the sound clip at ${c.s}s has no essence id (media)`, { at: c.s }); return { s: r6(c.s), e: r6(c.e), in: r6(c.in), media: c.media }; });
const audioId = (inp) => ({ rate: AVF.AR, ch: AVF.CH, fmt: "s16le", chunk: VF.CHUNK, ...(inp.aclips ? { clips: normAudio(inp.aclips) } : {}) });
const avWhere = (inp) => { const w = vfoldProjector.where(inp); for (const c of inp.aclips || []) if (c.path) w[c.media] ||= c.path; return w; };
const avInputs = (body, resolve) => { const r = vfoldProjector.inputsFromBody(body, resolve), ac = body.audio && body.audio.clips; if (!ac) return r;
  const missing = [...r.missing], aclips = ac.map((c) => { const p = resolve(c.media, body.where && body.where[c.media]); if (!p || !fs.existsSync(p)) missing.push(c.media); return { ...c, crop: "", path: p }; }); return { inputs: { ...r.inputs, aclips }, missing }; };
// ---- picture with sound: the same projector with an audio track (lib/avfold.mjs). A different projector name, so a recipe says which one made it.
import * as AVF from "./avfold.mjs";
export const AV_PROJECTOR = `vfold-av@v${VF.V}.${AVF.AV}`;
export const avProjector = {
  ...vfoldProjector, name: AV_PROJECTOR, where: avWhere, inputsFromBody: avInputs,
  identity(inp) { const id = vfoldProjector.identity(inp); return { ...id, projector: AV_PROJECTOR, audio: audioId(inp) }; },
  async build({ clips, total, aclips }, { workers = 6, onChunk = () => {}, deep = false } = {}) {
    const norm = normalise(clips), v = await AVF.avfold(norm, total, { aclips: aclips && normalise(aclips), workers, onChunk });
    return { v, size: v.size, frames: v.frames, chunks: v.chunks, header_sha256: sha(v.header), ...(deep ? { file_sha256: fileSha256(v) } : {}), ms: v.ms, made: v.made, clips: norm };
  },
};
// ---- long-GOP picture (lib/lgfold.mjs): near render size, cuts still a header change (edit list hides the frames before a clip's keyframe). With or without sound.
import * as LGF from "./lgfold.mjs";
export const LG_PROJECTOR = `lgfold@v${LGF.LV}`, LGAV_PROJECTOR = `lgfold-av@v${LGF.LV}.${AVF.AV}`;
// the frame rate: 24 unless the recipe says otherwise (`fps`, a whole number dividing 48000). At 24 every id and every byte is what it was before the rate was a parameter.
const lgInputs = (audio) => (body, resolve) => { const r = (audio ? avInputs : vfoldProjector.inputsFromBody)(body, resolve), fps = body.fps || 24; return { ...r, inputs: { ...r.inputs, fps, total: body.frames / fps } }; };
const lgProjector = (audio) => { const name = audio ? LGAV_PROJECTOR : LG_PROJECTOR; return {
  ...vfoldProjector, name, ...(audio ? { where: avWhere } : {}), inputsFromBody: lgInputs(audio),
  identity(inp) { const fps = inp.fps || 24, f = LGF.FMT(fps), id = vfoldProjector.identity(inp); return { ...id, fps, frames: Math.round(inp.total * fps), projector: name, enc: LGF.encId(f), ...(audio ? { audio: audioId(inp) } : {}) }; },
  async build({ clips, total, aclips, fps = 24 }, { workers = 6, onChunk = () => {}, deep = false } = {}) {
    const norm = normalise(clips), v = await LGF.lgfold(norm, total, { audio, aclips: audio && aclips ? normalise(aclips) : null, fps, workers, onChunk });
    return { v, size: v.size, frames: v.frames, chunks: v.chunks, header_sha256: sha(v.header), ...(deep ? { file_sha256: fileSha256(v) } : {}), ms: v.ms, made: v.made, clips: norm };
  },
}; };
export const lgProj = lgProjector(false), lgavProj = lgProjector(true);
const PROJECTORS = { [PROJECTOR]: vfoldProjector, [AV_PROJECTOR]: avProjector, [LG_PROJECTOR]: lgProj, [LGAV_PROJECTOR]: lgavProj };
/** the projector that made a recorded recipe, by the name it recorded (unknown names fall to the picture projector, which then reports recipe_mismatch) */
export const projectorFor = (name) => PROJECTORS[name] || vfoldProjector;
export const knownProjector = (name) => name in PROJECTORS;
const pick = ({ audio = false, lg = false } = {}) => (lg ? (audio ? lgavProj : lgProj) : audio ? avProjector : vfoldProjector);
const recordedProjector = (ph, { project, sequence }) => { const cur = PF.live(ph, project, sequence).at(-1); return projectorFor(cur && cur.body.projector); };

// ---- the same API as before, in terms of clips and total. `audio: true` records with sound; open and check follow whatever the recipe recorded.
const checkFps = (fps, lg) => { if (fps != null && fps !== 24 && !lg) throw new VfileError("bad_fps", "the all-intra fold conforms to 24 fps only; use the long-GOP fold (--lg) for another frame rate"); };
export const recipeOf = (clips, total, o = {}) => { checkFps(o.fps, o.lg); return PF.recipeOf(pick(o), { clips, total, ...(o.aclips ? { aclips: o.aclips } : {}), ...(o.fps ? { fps: o.fps } : {}) }); };
export async function build(clips, total, opts = {}) { checkFps(opts.fps, opts.lg); const P = pick(opts), b = await P.build({ clips, total, ...(opts.aclips ? { aclips: opts.aclips } : {}), ...(opts.fps ? { fps: opts.fps } : {}) }, opts); return { ...b, recipe: recipeOf(clips, total, opts) }; }
export const record = async (ph, by, { project, sequence, clips, aclips = null, fps = null, total, cite = null }, { audio = false, lg = false, ...opts } = {}) => { checkFps(fps, lg); return PF.record(ph, by, { project, sequence, inputs: { clips, total, ...(aclips ? { aclips } : {}), ...(fps ? { fps } : {}) }, cite }, { projector: pick({ audio, lg }), ...opts }); };
export const open = (ph, q, opts = {}) => PF.open(ph, q, { projector: recordedProjector(ph, q), ...opts });
export const check = (ph, by, q, opts = {}) => PF.check(ph, by, q, { projector: recordedProjector(ph, q), ...opts });
