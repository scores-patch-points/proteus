// Eviction for LONG-GOP and SOUND chunks, at any frame rate: an evict request drops exactly the chunks nothing live still needs, picture and sound, and nothing else. Run: node --test test/manage-lg.test.mjs
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manage-lg-")), CACHE = path.join(tmp, "chunks"); process.env.SLATE_VFOLD_CACHE = CACHE; process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const { loadLib, Pharos } = await import("../lib/door.mjs"); const VFL = await import("../lib/vfile.mjs"); const MG = await import("../lib/manage.mjs"); const LGF = await import("../lib/lgfold.mjs"); const AVF = await import("../lib/avfold.mjs"); const DF = await import("../lib/docfold.mjs"); const { essence } = await import("../lib/essence.mjs");
const ff = (...a) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a]); if (r.status !== 0) throw new Error("ffmpeg: " + r.stderr); };
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
const mk = (n, rate, tone) => { const f = path.join(tmp, "src", n + ".mov"); ff("-f", "lavfi", "-i", `testsrc2=s=640x360:r=${rate}:d=8`, "-f", "lavfi", "-i", `aevalsrc=sin(2*PI*(${tone}+30*t)*t)|sin(2*PI*(${tone + 200}+20*t)*t):s=48000:d=8`, "-c:v", "libx264", "-g", "60", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", f); return f; };
const S = { C: mk("c", 24, 300), D: mk("d", 24, 600), F: mk("f", 24, 900), E: mk("e", 30, 500) }, M = Object.fromEntries(Object.entries(S).map(([k, f]) => [k, essence(f, { persist: false })]));
const clip = (s, e, i, k) => ({ s, e, in: i, media: M[k], path: S[k], crop: "" }), lib = await loadLib(), by = "proteus"; let n = 0; const fresh = () => new Pharos({ dir: path.join(tmp, `ph${++n}`), lib });
const exists = (p) => fs.existsSync(p), pic = (k, fps = 24) => LGF.chunkPath(M[k], "", 0, fps), snd = (k) => AVF.audioChunkPath(M[k], 0), black = (fps = 24) => path.join(path.dirname(path.dirname(LGF.chunkPath("x", "", 0, fps))), "black.mp4");
function eodb(ph) {
  const w = lib.P.open(ph.name, { dir: ph.dir, writer: "eodb" }); for (const [k, c] of [["vfile-pin", "DEF·Figure"], ["vfile-evict", "SEG·Figure"]]) lib.P.weave(w, { cell: "DEF·Figure", kind: "kind", addr: `kind:${k}`, body: { name: k, cell: c }, basis: {} });
  const weave = (cell, kind, r) => lib.P.weave(w, { cell, kind, addr: `${kind}:${r.recipe.slice(0, 16)}`, body: { recipe: r.recipe, why: "test", nonce: Math.random() }, of: [r.id], basis: {} });
  return { pin: (r) => weave("DEF·Figure", "vfile-pin", r), evict: (r) => weave("SEG·Figure", "vfile-evict", r) };
}
// X: picture C then D, with their own sound. Y: picture C (+ its sound), so C's chunks are SHARED with X. Z: picture C but its sound is the A1 clip from F (not C's own).
const rec = async (ph, name, clips, total, o = {}) => VFL.record(ph, by, { project: "p", sequence: name, clips, total, ...o }, { lg: true, audio: true, deep: true });
async function setup() { const ph = fresh(), rx = await rec(ph, "X", [clip(0, 3, 0.5, "C"), clip(3, 6, 1.0, "D")], 6), ry = await rec(ph, "Y", [clip(0, 3, 0.5, "C")], 3), rz = await rec(ph, "Z", [clip(0, 3, 0.5, "C")], 3, { aclips: [clip(0, 3, 0.5, "F")] }); return { ph, rx, ry, rz }; }
const body = (ph, r) => ph.entry(r.id).body;

test("FALSE IF: a recipe's needs are guessed wrong: a long-GOP recipe needs its picture chunks and its sound chunks (from A1 when it has A1, else from its picture clips), nothing else, and all of them exist on disk after the build", async () => {
  const { ph, rx, rz } = await setup();
  assert.deepEqual(MG.chunkPaths(body(ph, rx)).sort(), [pic("C"), pic("D"), snd("C"), snd("D")].sort());
  assert.deepEqual(MG.chunkPaths(body(ph, rz)).sort(), [pic("C"), snd("F")].sort(), "Z's sound comes from F, so C's own sound is not Z's need");
  for (const p of [pic("C"), pic("D"), snd("C"), snd("D"), snd("F")]) assert.ok(exists(p), p);
});

test("FALSE IF: eviction drops what a live file needs, or leaves what nothing needs: evicting X removes exactly its own picture chunk D and sound chunk D, keeps C (picture and sound), which Y still needs, and never the black chunk; a dry run deletes nothing", async () => {
  const { ph, rx } = await setup(), E = eodb(ph); E.evict(rx);
  const dry = MG.sweep(ph, by, { dry: true }); assert.equal(dry.results[0].result, "dropped"); assert.equal(dry.results[0].chunks_removed, 2); assert.equal(dry.results[0].shared_kept, 2); assert.ok(exists(pic("D")) && exists(snd("D")), "a dry run deletes nothing");
  const r = MG.sweep(ph, by); assert.equal(r.results[0].chunks_removed, 2); assert.ok(r.results[0].bytes > 0);
  assert.ok(!exists(pic("D")) && !exists(snd("D")), "its own chunks are gone"); assert.ok(exists(pic("C")) && exists(snd("C")), "shared with the live file Y: kept"); assert.ok(exists(snd("F")) && exists(black()), "unrelated and shared-black chunks untouched");
  assert.equal(ph.fold({ kind: "vfile-evicted" }).matched, 1, "answered once, as a ledger entry");
});

test("FALSE IF: a pinned file loses its chunks: a pin refuses the eviction and deletes nothing, and a pin on Y protects the chunks it shares with an evicted Z", async () => {
  const { ph, rx, ry, rz } = await setup(), E = eodb(ph); E.pin(rx); E.evict(rx); let r = MG.sweep(ph, by); assert.equal(r.results[0].result, "refused_pinned"); assert.ok([pic("C"), pic("D"), snd("C"), snd("D")].every(exists));
  E.pin(ry); E.evict(rz); r = MG.sweep(ph, by); const z = r.results.find((x) => x.recipe === rz.recipe); assert.equal(z.result, "dropped"); assert.ok(exists(pic("C")), "C's picture is Y's and X's too: kept"); assert.ok(!exists(snd("F")), "F's sound was only Z's: dropped");
});

test("FALSE IF: eviction is not just a cache: after it, rebuilding the recipe from the ledger gives the same file, byte for byte (picture and sound)", async () => {
  const { ph, rx } = await setup(), E = eodb(ph); E.evict(rx); MG.sweep(ph, by); assert.ok(!exists(pic("D")));
  const c = await VFL.check(ph, by, { project: "p", sequence: "X" }, { deep: true }); assert.equal(c.status, "identical", JSON.stringify({ e: c.expected, f: c.found })); assert.ok(c.made >= 2 && exists(pic("D")) && exists(snd("D")), "rebuilt");
});

test("FALSE IF: frame rates share a folder: evicting a 30 fps recipe removes only its 30 fps chunk, never the 24 fps chunk of the same clip, and the reverse", async () => {
  const ph = fresh(), r30 = await VFL.record(ph, by, { project: "p", sequence: "W30", clips: [clip(0, 3, 0.5, "E")], total: 3, fps: 30 }, { lg: true }), r24 = await VFL.record(ph, by, { project: "p", sequence: "W24", clips: [clip(0, 3, 0.5, "E")], total: 3 }, { lg: true });
  assert.ok(exists(pic("E", 30)) && exists(pic("E", 24)) && pic("E", 30) !== pic("E", 24)); assert.deepEqual(MG.chunkPaths(body(ph, r30)), [pic("E", 30)]);
  eodb(ph).evict(r30); const r = MG.sweep(ph, by); assert.equal(r.results[0].chunks_removed, 1); assert.equal(r.results[0].shared_kept, 0); assert.ok(!exists(pic("E", 30)) && exists(pic("E", 24)), "the 24 fps chunk is untouched"); assert.ok(exists(black(30)) && exists(black(24)));
  void r24;
});

test("FALSE IF: a document or an unknown projector makes eviction delete something: a Word-document recipe needs no chunks (an evict request is answered, nothing removed), and a recipe from an unknown projector needs none", async () => {
  const { buildScenario, DOC } = await import("./doc-scenario.mjs"), s = await buildScenario(path.join(tmp, "docs")), dph = new Pharos({ dir: s.M3, lib }), rd = await DF.recordDoc(dph, by, { doc: DOC, owner: "alice" });
  const entry = dph.L.P.fold(dph.reader(), { kind: "vfile" }).entries.find((e) => e.body.project === DOC); assert.deepEqual(MG.chunkPaths(entry.body), []);
  const before = fs.existsSync(CACHE) ? fs.readdirSync(CACHE).length : 0; eodb(dph).evict({ recipe: rd.recipe, id: entry.id }); const r = MG.sweep(dph, by); assert.equal(r.results[0].result, "dropped"); assert.equal(r.results[0].chunks_removed, 0); assert.equal(fs.existsSync(CACHE) ? fs.readdirSync(CACHE).length : 0, before);
  assert.deepEqual(MG.chunkPaths({ projector: "mystery@v9", clips: [clip(0, 3, 0, "C")], frames: 72 }), []);
});
