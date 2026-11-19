// Proteus: the virtual file on the pharos. A recipe woven as an entry, rebuilt from the pharos alone, checked by rebuilding. Needs ffmpeg and ffprobe.
// Run: node --test test/vfile.test.mjs
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vfile-test-")), CACHE = path.join(tmp, "chunks"); process.env.SLATE_VFOLD_CACHE = CACHE;     // before vfold is imported
const { loadLib, Pharos } = await import("../lib/door.mjs"); const { clipsFromPlacements } = await import("../lib/placements.mjs"); const VFL = await import("../lib/vfile.mjs"); const { essence } = await import("../lib/essence.mjs");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const ff = (...a) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a]); if (r.status !== 0) throw new Error("ffmpeg: " + r.stderr); };
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
const A = path.join(tmp, "src", "a.mp4"), B = path.join(tmp, "src", "b.mp4");
ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=6", "-c:v", "libx264", "-g", "48", "-pix_fmt", "yuv420p", A);
ff("-f", "lavfi", "-i", "smptebars=s=640x360:r=24:d=6", "-c:v", "libx264", "-g", "48", "-pix_fmt", "yuv420p", B);
const eA = essence(A, { persist: false }), eB = essence(B, { persist: false });
const clips = () => [{ s: 0, e: 3, in: 0, media: eA, path: A, crop: "" }, { s: 3, e: 6, in: 1, media: eB, path: B, crop: "" }];
const resolver = (m) => ({ [eA]: A, [eB]: B })[m] || null;
const by = "operator:tester";
let n = 0;
async function fresh() { const dir = path.join(tmp, `ph${++n}`); return new Pharos({ dir, lib: await loadLib() }); }

// what the editor does, as another writer: declare `placement` (its kind, not ours) and weave placements. Proteus only ever reads them.
function slateWeaves(ph, addr, body) {
  const sg = ph.L.P.open(ph.name, { dir: ph.dir, writer: "slate-gui" }), g = ph.L.P.ground(sg);
  if (!g.kinds.some((k) => k.name === "placement")) ph.L.P.weave(sg, { cell: "DEF·Figure", kind: "kind", addr: "kind:placement", body: { name: "placement", cell: "INS·Figure" }, basis: {} });
  return ph.L.P.weave(sg, { cell: "INS·Figure", kind: "placement", addr, body, of: [], basis: {} });
}
const ids = (ph, kind) => ph.fold({ kind, limit: 200 }).entries.map((e) => e.id);

test("the recipe is identity by content: paths are hints, order does not matter, any change of span or source changes it, and a clip with no essence is refused", () => {
  const a = VFL.recipeOf(clips(), 6).id;
  assert.equal(VFL.recipeOf(clips().map((c) => ({ ...c, path: "/elsewhere/" + path.basename(c.path) })), 6).id, a, "the path is not part of the identity");
  assert.equal(VFL.recipeOf([...clips()].reverse(), 6).id, a);
  assert.equal(VFL.recipeOf(clips().map((c) => ({ ...c, s: c.s + 1e-9 })), 6).id, a, "float noise below a microsecond is not a different edit");
  const c2 = clips(); c2[1].in = 1.5; assert.notEqual(VFL.recipeOf(c2, 6).id, a);
  const c3 = clips(); c3[0].media = eB; assert.notEqual(VFL.recipeOf(c3, 6).id, a);
  assert.notEqual(VFL.recipeOf(clips(), 7).id, a, "the length is part of it");
  assert.throws(() => VFL.recipeOf([{ s: 0, e: 1, in: 0, path: A }], 1), (e) => e.code === "no_essence");
});

test("record weaves the recipe at SYN·Pattern citing the placements it was made from, holds no bytes, and an unchanged edit weaves nothing", async () => {
  const ph = await fresh(), P = (clip, s, e) => slateWeaves(ph, `clip:p1:${clip}`, { project: "p1", sequence: "Main", clip, source: clip, track: "V1", s, e, in: 0, out: e - s }).id;
  const pl = [P("c1", 0, 3), P("c2", 3, 6)];
  const r = await VFL.record(ph, by, { project: "p1", sequence: "Main", clips: clips(), total: 6 });
  assert.equal(r.unchanged, false); assert.equal(r.retracted, 0); assert.ok(r.size > 100000 && r.chunks >= 2, JSON.stringify(r));
  const e = ph.entry(r.id);
  assert.equal(e.cell, "SYN·Pattern"); assert.equal(e.kind, "vfile"); assert.equal(e.addr, "vfile:p1:Main"); assert.deepEqual([...e.of].sort(), [...pl].sort());
  assert.equal(e.body.recipe, VFL.recipeOf(clips(), 6).id); assert.equal(e.body.size, r.size); assert.equal(e.body.header_sha256, r.header_sha256); assert.equal(e.body.frames, 144);
  assert.equal(e.basis.instrument.startsWith("proteus@"), true); assert.equal(e.basis.schema, "proteus/vfile@1");
  assert.ok(JSON.stringify(e.body).length < 2000 && r.size > 50 * JSON.stringify(e.body).length, "the entry is a recipe, not the file");
  const again = await VFL.record(ph, by, { project: "p1", sequence: "Main", clips: clips(), total: 6 });
  assert.equal(again.unchanged, true); assert.equal(again.id, r.id); assert.equal(ids(ph, "vfile").length, 1);
});

test("a changed edit retracts the old recipe and weaves the new one: exactly one live vfile per file, and the old one is still in the log", async () => {
  const ph = await fresh(), q = { project: "p2", sequence: "Main", total: 6 };
  const r1 = await VFL.record(ph, by, { ...q, clips: clips() });
  const c = clips(); c[1].in = 2;
  const r2 = await VFL.record(ph, by, { ...q, clips: c });
  assert.notEqual(r2.recipe, r1.recipe); assert.equal(r2.retracted, 1);
  const liveNow = VFL.live(ph, "p2", "Main"); assert.equal(liveNow.length, 1); assert.equal(liveNow[0].id, r2.id);
  assert.ok(ph.L.P.entries(ph.reader()).some((x) => x.id === r1.id), "retracted, never erased");
});

test("a reader with only the pharos and the media rebuilds the same virtual file, and it is a real mp4 (ffprobe)", async () => {
  const ph = await fresh(); await VFL.record(ph, by, { project: "p3", sequence: "Main", clips: clips(), total: 6 });
  const other = new Pharos({ dir: ph.dir, lib: await loadLib() });                    // another connection to the same pharos: knows nothing of the first
  assert.equal(other.fold({ kind: "vfile" }).matched, 1, "found by kind, not by author");
  const o = await VFL.open(other, { project: "p3", sequence: "Main" }, { resolve: resolver });          // ignores the recorded path hints
  assert.equal(o.status, "identical", JSON.stringify({ e: o.expected, f: o.found }));
  const file = path.join(tmp, "out.mp4"); const fd = fs.openSync(file, "w"); for (const b of VFL.VF.readRange(o.v, 0, o.v.size - 1)) fs.writeSync(fd, b); fs.closeSync(fd);
  assert.equal(fs.statSync(file).size, o.v.size);
  const pr = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_read_frames", "-show_entries", "format=duration", "-of", "json", file], { encoding: "utf8" }).stdout);
  assert.equal(pr.streams[0].width, 1280); assert.equal(pr.streams[0].height, 720); assert.equal(pr.streams[0].r_frame_rate, "24/1"); assert.equal(+pr.streams[0].nb_read_frames, 144); assert.ok(Math.abs(+pr.format.duration - 6) < 0.05);
});

test("check weaves the evidence at EVA·Pattern; a missing source is 'unavailable' and names the essence, never an exception; a deep check hashes the file's bytes", async () => {
  const ph = await fresh(), q = { project: "p4", sequence: "Main" }; await VFL.record(ph, by, { ...q, clips: clips(), total: 6 }, { deep: true });
  const ok = await VFL.check(ph, by, q, { resolve: resolver, deep: true });
  assert.equal(ok.status, "identical"); assert.ok(ok.expected.file_sha256 && ok.found.file_sha256 === ok.expected.file_sha256, "the bytes themselves match");
  const ce = ph.entry(ok.check); assert.equal(ce.cell, "EVA·Pattern"); assert.equal(ce.kind, "vfile-check"); assert.equal(ce.body.result, "identical"); assert.deepEqual(ce.of, [ok.entry]);
  const gone = await VFL.check(ph, by, q, { resolve: (m) => (m === eB ? null : resolver(m)) });
  assert.equal(gone.status, "unavailable"); assert.deepEqual(gone.missing, [eB]); assert.equal(ph.entry(gone.check).body.result, "unavailable");
});

test("the chunk cache is only a cache, and determinism is measured, not assumed: delete it, rebuild from the recipe, and record whether the bytes came back the same", async (t) => {
  const ph = await fresh(), q = { project: "p5", sequence: "Main" }; await VFL.record(ph, by, { ...q, clips: clips(), total: 6 }, { deep: true });
  fs.rmSync(CACHE, { recursive: true, force: true });
  const r = await VFL.check(ph, by, q, { resolve: resolver, deep: true });
  assert.ok(r.made >= 2, "the chunks were encoded again");
  assert.ok(["identical", "differs"].includes(r.status)); assert.equal(ph.entry(r.check).body.result, r.status, "whatever happened is what was recorded");
  t.diagnostic(`rebuild with an empty chunk cache on this machine: ${r.status} (${r.made} chunks re-encoded in ${r.ms} ms); expected ${JSON.stringify(r.expected)}, found ${JSON.stringify(r.found)}`);
});

test("a recipe made by a different projector version is not reproduced silently: recipe_mismatch, and the check says so", async () => {
  const ph = await fresh(), q = { project: "p6", sequence: "Main" }; const r = await VFL.record(ph, by, { ...q, clips: clips(), total: 6 });
  const e = ph.entry(r.id);
  ph.L.P.weave(ph.handle(by), { cell: "SYN·Pattern", kind: "vfile", addr: e.addr, body: { ...e.body, projector: "vfold@v1", recipe: "x".repeat(64) }, of: [], basis: {} }); ph.retract(by, [e.id], { why: "test: pretend an older projector wrote it" });
  const c = await VFL.check(ph, by, q, { resolve: resolver }); assert.equal(c.status, "recipe_mismatch"); assert.equal(ph.entry(c.check).body.recorded_projector, "vfold@v1");
});

test("record without a build weaves only the recipe: no ffmpeg, no chunks, size null; a later check says 'unrecorded' and what the recipe builds to; a build then records it", async () => {
  fs.rmSync(CACHE, { recursive: true, force: true });
  const ph = await fresh(), q = { project: "p7", sequence: "Main" };
  const r = await VFL.record(ph, by, { ...q, clips: clips(), total: 6 }, { build: false });
  assert.equal(r.built, false); assert.equal(r.made, 0); assert.equal(r.size, null); assert.ok(!fs.existsSync(CACHE), "nothing was encoded: the chunk cache does not even exist");
  const e = ph.entry(r.id); assert.equal(e.body.size, null); assert.equal(e.body.recipe, VFL.recipeOf(clips(), 6).id); assert.equal(e.cell, "SYN·Pattern");
  assert.equal((await VFL.record(ph, by, { ...q, clips: clips(), total: 6 }, { build: false })).unchanged, true);
  const c = await VFL.check(ph, by, q, { resolve: resolver }); assert.equal(c.status, "unrecorded"); assert.ok(c.found.size > 100000 && c.found.header_sha256);
  const b = await VFL.record(ph, by, { ...q, clips: clips(), total: 6 }); assert.equal(b.unchanged, false, "a build upgrades the entry"); assert.equal(b.retracted, 1); assert.equal(ph.entry(b.id).body.header_sha256, c.found.header_sha256, "the same recipe builds to the same header");
  assert.equal((await VFL.check(ph, by, q, { resolve: resolver })).status, "identical");
});

// ---- Proteus reads the editor's placements from the pharos and makes the file: no call to the editor
test("from placements alone: Proteus reads the editor's placements by kind (relative paths resolved against the project folder), weaves the recipe citing them, follows a moved clip, and checks identical", async () => {
  const ph = await fresh(), q = { project: "p9", sequence: "seq_main" };
  const P = (clip, s, e, inn, file) => slateWeaves(ph, `clip:p9:${clip}`, { ...q, clip, source: file, track: "V1", s, e, in: inn, out: inn + e - s, path: path.join("src", file) });
  const p1 = P("c1", 0, 3, 0, "a.mp4"), p2 = P("c2", 3, 6, 1, "b.mp4");
  const { clips: cs, total, cites } = clipsFromPlacements(ph, { ...q, root: tmp });
  assert.equal(total, 6); assert.deepEqual([...cites].sort(), [p1.id, p2.id].sort());
  assert.equal(VFL.recipeOf(cs, total).id, VFL.recipeOf(clips(), 6).id, "the same recipe as building from the clips directly: the essences come from the files");
  const r = await VFL.record(ph, by, { ...q, clips: cs, total, cite: cites }, { build: true }); assert.equal(r.built, true); assert.deepEqual([...ph.entry(r.id).of].sort(), [p1.id, p2.id].sort());
  assert.equal((await VFL.check(ph, by, q, { resolve: resolver })).status, "identical");
  ph.retract("slate-gui", [p2.id], { why: "moved" }); P("c2b", 3, 6, 2, "b.mp4");                     // the editor moves the second clip's in point
  const again = clipsFromPlacements(ph, { ...q, root: tmp }); assert.equal(again.clips.length, 2); assert.ok(!again.cites.includes(p2.id), "a retracted placement is ignored");
  const r2 = await VFL.record(ph, by, { ...q, clips: again.clips, total: again.total, cite: again.cites }, { build: false }); assert.equal(r2.unchanged, false); assert.equal(r2.retracted, 1);
  assert.throws(() => clipsFromPlacements(ph, { ...q, root: null }), (e) => e.code === "no_file", "a relative path with no project folder given is refused, not guessed");
  assert.throws(() => clipsFromPlacements(ph, { project: "p9", sequence: "nope", root: tmp }), (e) => e.code === "no_picture");
});

// ---- the generic part knows nothing of video
test("pfile is generic: it imports nothing from Slate, and a toy projector with no video and no ffmpeg gets the same recipe, retraction, check and determinism evidence", async () => {
  const PF = await import("../lib/pfile.mjs");
  const src = fs.readFileSync(new URL("../lib/pfile.mjs", import.meta.url), "utf8");
  assert.deepEqual([...src.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]), ["node:crypto"], "only node:crypto: nothing of Slate, video or ffmpeg");
  const store = { a: "alpha ", b: "beta ", c: "gamma " }, builds = { n: 0 };
  const toy = { name: "toy@v1", identity: ({ parts }) => ({ projector: "toy@v1", frames: parts.length, parts: parts.map((p) => p.id) }), where: ({ parts }) => Object.fromEntries(parts.map((p) => [p.id, "hint:" + p.id])),
    inputsFromBody: (body, resolve) => { const missing = [], parts = body.parts.map((id) => { const t = resolve(id, body.where[id]); if (t == null) missing.push(id); return { id, text: t }; }); return { inputs: { parts }, missing }; },
    build: async ({ parts }) => { builds.n++; const text = parts.map((p) => p.text).join(""); return { size: text.length, header_sha256: PF.sha(text), chunks: parts.length, ms: 0, made: 0 }; } };
  const resolve = (id) => store[id] ?? null, ph = await fresh(), q = { project: "t", sequence: "s" }, parts = (...ids) => ({ parts: ids.map((id) => ({ id, text: store[id] })) });
  const r1 = await PF.record(ph, by, { ...q, inputs: parts("a", "b") }, { projector: toy });
  assert.equal(r1.unchanged, false); assert.equal(ph.entry(r1.id).cell, "SYN·Pattern"); assert.equal(ph.entry(r1.id).body.recipe, PF.recipeOf(toy, parts("a", "b")).id);
  assert.equal((await PF.record(ph, by, { ...q, inputs: parts("a", "b") }, { projector: toy })).unchanged, true);
  const r2 = await PF.record(ph, by, { ...q, inputs: parts("a", "c") }, { projector: toy }); assert.equal(r2.retracted, 1); assert.equal(PF.live(ph, "t", "s").length, 1);
  const ok = await PF.check(ph, by, q, { projector: toy, resolve }); assert.equal(ok.status, "identical");
  store.c = "GAMMA "; const drift = await PF.check(ph, by, q, { projector: toy, resolve }); assert.equal(drift.status, "differs", "an input that changed under the same id is reported, not hidden");
  assert.equal((await PF.check(ph, by, q, { projector: toy, resolve: (id) => (id === "c" ? null : store[id]) })).status, "unavailable");
  assert.equal((await PF.check(ph, by, q, { projector: { ...toy, name: "toy@v2" }, resolve })).status, "recipe_mismatch");
});
