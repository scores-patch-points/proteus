#!/usr/bin/env node
// proteus: makes projected files (today: the virtual mp4 of an edit) from what other repos wrote to the pharos, and weaves the recipe and the evidence.
//   proteus record --project P --sequence S [--root DIR] [--build] [--deep] [--audio] [--lg] [--fps N]   weave the recipe (--audio: with sound; --lg: long-GOP picture, ~10x smaller, at the first clip's own frame rate unless --fps N: 24, 25, 30, 50, 60 ...); --build also builds the header (runs ffmpeg for uncached chunks)
//   proteus check  --project P --sequence S [--deep]                          rebuild from the recorded recipe alone and weave the result
//   proteus status --project P --sequence S                                    the live recipe and the latest check (reads only the pharos)
//   proteus export --project P --sequence S --to FILE [--recipe PREFIX] [--force] [--allow-differs]   write a recipe out as a real file, verified, and weave a vfile-export entry
//   proteus exports [--project P] [--verify]                                   what has been written out: still there? changed? replaced by a newer recipe?
//   proteus sweep [--dry]                                                      honour vfile-evict / vfile-pin entries: drop cached chunks nothing else needs, weave vfile-evicted
//   proteus serve [--port 8787] [--host 127.0.0.1]                             serve every live recipe as /v/<recipe>.mp4 by byte range (HEAD, Range, 416)
// common: --pharos <folder|name> (default $PHAROS, then ~/.pharos/proteus)   --by <writer> (default proteus)
import * as D from "../lib/door.mjs"; import * as PF from "../lib/pfile.mjs"; import * as VFL from "../lib/vfile.mjs"; import { clipsFromPlacements } from "../lib/placements.mjs"; import * as MG from "../lib/manage.mjs";
const a = process.argv.slice(2), cmd = a[0], f = {}; for (let i = 1; i < a.length; i++) if (a[i].startsWith("--")) { const k = a[i].slice(2); f[k] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true; }
const out = (x) => console.log(JSON.stringify(x, null, 2));
try {
  if (cmd === "sweep") { const ph = new D.Pharos({ dir: D.pharosDir(f.pharos), lib: await D.loadLib() }); out({ pharos: ph.name, ...MG.sweep(ph, f.by || "proteus", { dry: !!f.dry }) }); process.exit(0); }
  if (cmd === "serve") { const { createServer } = await import("../lib/serve.mjs"); const ph = new D.Pharos({ dir: D.pharosDir(f.pharos), lib: await D.loadLib() }), port = +f.port || 8787, host = f.host || "127.0.0.1";
    createServer(ph, { log: (m) => console.error(m) }).listen(port, host, () => console.error(`proteus serving ${ph.name} at http://${host}:${port}/status  (files at /v/<recipe>.mp4)`)); await new Promise(() => {}); }
  if (cmd === "export") { const EX = await import("../lib/export.mjs"); const ph = new D.Pharos({ dir: D.pharosDir(f.pharos), lib: await D.loadLib() });
    out({ pharos: ph.name, ...(await EX.exportRecipe(ph, f.by || "proteus", { project: f.project, sequence: f.sequence, recipe: f.recipe, to: f.to, force: !!f.force, allowDiffers: !!f["allow-differs"] })) }); process.exit(0); }
  if (cmd === "exports") { const EX = await import("../lib/export.mjs"); const ph = new D.Pharos({ dir: D.pharosDir(f.pharos), lib: await D.loadLib() }); out({ pharos: ph.name, exports: EX.listExports(ph, { project: f.project, recipe: f.recipe, verify: !!f.verify }) }); process.exit(0); }
  if (!["record", "check", "status"].includes(cmd) || !f.project || !f.sequence) { console.error("usage: proteus <record|check|status|sweep> --project P --sequence S [--pharos D] [--root DIR] [--by W] [--build] [--deep]"); process.exit(2); }
  const ph = new D.Pharos({ dir: D.pharosDir(f.pharos), lib: await D.loadLib() }), q = { project: f.project, sequence: f.sequence }, by = f.by || "proteus";
  if (cmd === "status") {
    const cur = PF.live(ph, q.project, q.sequence).at(-1) || null, chk = ph.L.P.fold(ph.reader(), { kind: "vfile-check" }).entries.filter((e) => e.body && e.body.project === q.project && e.body.sequence === q.sequence).at(-1) || null;
    out({ pharos: ph.name, addr: PF.addrOf(q.project, q.sequence), vfile: cur && { id: cur.id, recipe: cur.body.recipe, projector: cur.body.projector, built: cur.body.header_sha256 != null, size: cur.body.size, cites: cur.of }, check: chk && { id: chk.id, result: chk.body.result, current: !!cur && chk.body.recipe === cur.body.recipe } });
  } else if (cmd === "record") {
    const { clips, aclips, total, cites, fps, fps_from } = clipsFromPlacements(ph, { ...q, root: f.root, fps: f.fps ? +f.fps : null, detect: !!f.lg }); out({ pharos: ph.name, ...(f.lg || f.fps ? { fps: f.lg ? fps : +f.fps, fps_from: f.lg ? fps_from : "given" } : {}), sound: f.audio ? (aclips ? `A1 track (${aclips.length} clips)` : "each picture clip's own sound (no A1 in this sequence)") : undefined, ...(await VFL.record(ph, by, { ...q, clips, aclips, total, cite: cites, fps: f.lg ? fps : (f.fps ? +f.fps : null) }, { build: !!f.build, deep: !!f.deep, audio: !!f.audio, lg: !!f.lg })) });
  } else { const { v, ...r } = await VFL.check(ph, by, q, { deep: !!f.deep }); out({ pharos: ph.name, ...r }); }
} catch (e) { console.error(`${e.code || "error"}: ${e.message}`); process.exit(1); }
