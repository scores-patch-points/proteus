// manage.mjs: Proteus HONOURING the management entries another repo (EODB) wove. It reads `vfile-pin` and `vfile-evict` by kind, drops cached chunks, and
// answers with `vfile-evicted`. It never decides what to keep: the decision is the entries'; it only refuses what the entries contradict (a pinned file).
//   Chunks are SHARED: the cache is keyed by (essence, crop, index), so two edits that use the same footage use the same chunk. A chunk is deleted only if
//   NO live file that is pinned or not under an evict request still needs it. What a recipe needs is recomputed from its own clips, by the projector that made it (picture chunks at its frame rate, sound chunks from the clips its sound comes from).
// Eviction is only a cache drop: the recipe stays in the ledger and the bytes rebuild from it on next use.
import fs from "node:fs";
import * as VF from "./vfold.mjs"; import * as LGF from "./lgfold.mjs"; import * as AVF from "./avfold.mjs"; import * as VFL from "./vfile.mjs";

const fold = (ph, kind) => ph.L.P.fold(ph.reader(), { kind }).entries;
/** the cached files a recorded recipe needs, by the projector that made it: picture chunks (all-intra, or long-GOP at the recipe's frame rate), the sound chunks of the clips the sound comes from
 *  (the A1 clips when the recipe has them, else the picture clips), nothing for a document. Frames outside any clip are black, which is shared and never evicted. An unknown projector needs nothing
 *  here: guessing paths would delete the wrong files. */
export function chunkPaths(body) {
  const kind = String(body.projector || ""), lg = kind === VFL.LG_PROJECTOR || kind === VFL.LGAV_PROJECTOR, audio = kind === VFL.AV_PROJECTOR || kind === VFL.LGAV_PROJECTOR, intra = kind === VFL.PROJECTOR || kind === VFL.AV_PROJECTOR;
  if (!lg && !intra) return [];
  const fps = body.fps || 24, total = body.frames / fps, clips = body.clips.map((c) => ({ s: c.s, e: c.e, in: c.in, media: c.media, crop: c.crop || "", path: "-" })), out = [];
  const { need } = lg ? LGF.plan(clips, total, fps) : VF.plan(clips, total); for (const c of need.values()) out.push(lg ? LGF.chunkPath(c.media, c.crop, c.k, fps) : VF.chunkPath(c.media, c.crop, c.k));
  if (audio) { const ac = body.audio && body.audio.clips ? body.audio.clips.map((c) => ({ ...c, crop: "", path: "-" })) : clips; for (const c of AVF.planAudio(ac, total, fps).need.values()) out.push(AVF.audioChunkPath(c.media, c.k)); }
  return out;
}
/** answer every unanswered evict request. { dry: true } reports what would happen and weaves nothing. */
export function sweep(ph, by, { dry = false } = {}) {
  const vfiles = fold(ph, "vfile"), pins = new Set(fold(ph, "vfile-pin").map((e) => e.body && e.body.recipe)), evicts = fold(ph, "vfile-evict").filter((e) => e.body && e.body.recipe);
  const acked = new Set(fold(ph, "vfile-evicted").map((e) => e.body && e.body.evict)), requested = new Set(evicts.map((e) => e.body.recipe));
  const protect = new Set(); for (const v of vfiles) if (pins.has(v.body.recipe) || !requested.has(v.body.recipe)) for (const p of chunkPaths(v.body)) protect.add(p);
  const out = [];
  for (const e of evicts.filter((x) => !acked.has(x.id))) {
    const recipe = e.body.recipe, v = vfiles.find((f) => f.body.recipe === recipe); let result = "dropped", removed = 0, bytes = 0, shared = 0;
    if (pins.has(recipe)) result = "refused_pinned";
    else if (!v) result = "no_such_file";
    else for (const p of chunkPaths(v.body)) {
      if (protect.has(p)) { shared++; continue; }
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (!dry) fs.rmSync(p, { force: true }); removed++; bytes += st.size;
    }
    const rec = { recipe, evict: e.id, result, chunks_removed: removed, bytes, shared_kept: shared };
    out.push({ ...rec, ...(dry ? { dry: true } : { id: ph.weave(by, "vfile-evicted", `vfile-evicted:${e.id.slice(0, 16)}`, rec, [e.id]).id }) });
  }
  return { answered: out.length, results: out };
}
