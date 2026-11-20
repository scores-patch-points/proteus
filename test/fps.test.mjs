// Proteus long-GOP fold at the sequence's frame rate (24, 25, 30, 50 ...), not a fixed 24. Each test names how the claim could be false.
// Run: node --test test/fps.test.mjs
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fps-test-")), CACHE = path.join(tmp, "chunks"); process.env.SLATE_VFOLD_CACHE = CACHE; process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const { loadLib, Pharos } = await import("../lib/door.mjs"); const VFL = await import("../lib/vfile.mjs"); const LGF = await import("../lib/lgfold.mjs"); const { essence } = await import("../lib/essence.mjs"); const { clipsFromPlacements, sourceFps } = await import("../lib/placements.mjs");
const ff = (...a) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a], { maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error("ffmpeg: " + r.stderr); return r; };
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
const mk = (name, rate, tone) => { const f = path.join(tmp, "src", name + ".mov"); ff("-f", "lavfi", "-i", `testsrc2=s=640x360:r=${rate}:d=8`, "-f", "lavfi", "-i", `aevalsrc=sin(2*PI*(${tone}+30*t)*t)|sin(2*PI*(${tone + 200}+20*t)*t):s=48000:d=8`, "-c:v", "libx264", "-g", "60", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", f); return f; };
const SRC = { 24: mk("r24", 24, 300), 25: mk("r25", 25, 500), 30: mk("r30", 30, 700), 50: mk("r50", 50, 900), 2997: mk("r2997", "30000/1001", 1100) };
const ESS = Object.fromEntries(Object.entries(SRC).map(([k, f]) => [k, essence(f, { persist: false })])), clip = (s, e, i, k) => ({ s, e, in: i, media: ESS[k], path: SRC[k], crop: "" });
const lib = await loadLib(), ph = new Pharos({ dir: path.join(tmp, "ph"), lib }), by = "operator:tester";
const md5s = (input) => spawnSync("ffmpeg", ["-v", "error", "-i", input, "-an", "-vf", "format=yuv420p", "-f", "framemd5", "-"], { maxBuffer: 1 << 28 }).stdout.toString().split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop().trim());
const packets = (f) => spawnSync("ffmpeg", ["-v", "error", "-i", f, "-c", "copy", "-f", "framemd5", "-"], { maxBuffer: 1 << 26 }).stdout.toString().split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop().trim());
const writeVirtual = (v, f) => { const fd = fs.openSync(f, "w"); try { for (const b of VFL.VF.readRange(v, 0, v.size - 1)) fs.writeSync(fd, b); } finally { fs.closeSync(fd); } };
const probe = (f) => JSON.parse(spawnSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,r_frame_rate,duration,nb_read_frames,sample_rate", "-of", "json", f]).stdout).streams;
const audioOf = (f) => ff("-i", f, "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "-").stdout;
const cut = (src, s0, s1) => ff("-i", src, "-vn", "-af", `aresample=48000,atrim=start_sample=${s0}:end_sample=${s1}`, "-f", "s16le", "-ar", "48000", "-ac", "2", "-").stdout;
const total = 6, mkClips = (F) => [clip(0, 2, 0.7, F), clip(3, 6, 1.3, F === 25 ? 30 : 25)];       // a source at the SAME rate, a gap, a source at ANOTHER rate; both start mid-GOP

for (const F of [24, 25, 30, 50]) {
  test(`FALSE IF: at ${F} fps the file is not ${F} fps: ${F}/1, exactly ${total * F} frames, ${total} s, exactly ${total * 48000} samples, every decoded frame equals the frame the plan names, and the sound equals direct sample cuts at the frame-grid boundaries`, async () => {
    const clips = mkClips(F), r = await VFL.record(ph, by, { project: `f${F}`, sequence: "Main", clips, total, fps: F }, { lg: true, audio: true, deep: true }), { v } = await VFL.open(ph, { project: `f${F}`, sequence: "Main" }), file = path.join(tmp, `f${F}.mp4`); writeVirtual(v, file);
    assert.equal(r.frames, total * F); const s = probe(file), vid = s.find((x) => x.codec_type === "video"), aud = s.find((x) => x.codec_type === "audio");
    assert.equal(vid.r_frame_rate, `${F}/1`); assert.equal(+vid.duration, total); assert.equal(vid.nb_read_frames, String(total * F)); assert.equal(+aud.duration, total); assert.equal(audioOf(file).length / 4, total * 48000);
    const pl = LGF.plan(clips, total, F), cache = new Map(), get = (f) => cache.get(f) || cache.set(f, md5s(f)).get(f), blackFile = path.join(path.dirname(path.dirname(LGF.chunkPath("x", "", 0, F))), "black.mp4");
    const want = pl.frames.map((x) => { if (!x) return get(blackFile)[0]; const c = pl.need.get(x.key), m = get(LGF.chunkPath(c.media, c.crop, c.k, F)); return m[Math.min(x.j, m.length - 1)]; }), got = md5s(file);
    assert.equal(got.length, want.length); assert.equal(got.findIndex((x, i) => x !== want[i]), -1, "first wrong frame");
    const pf = 48000 / F, N = total * 48000, exp = Buffer.alloc(N * 4); for (const c of clips) { const a0 = Math.round(c.s * F) * pf, a1 = Math.round(c.e * F) * pf, s0 = Math.round(c.in * 48000); cut(c.path, s0, s0 + (a1 - a0)).copy(exp, a0 * 4); }
    assert.ok(audioOf(file).equals(exp), "sound is exact");
  });
}

test("FALSE IF: the cadence complaint is real and not fixed: a 30 fps source folded at 30 fps maps output frame i to source frame i (nothing dropped); folded at 24 fps the same source maps frame i to source frame round(i x 1.25), which is the old behaviour", async () => {
  const psnr = (a, b) => { const r = spawnSync("ffmpeg", ["-i", a, "-i", b, "-lavfi", "psnr", "-f", "null", "-"]), m = /average:([\d.inf]+)/.exec(r.stderr.toString()); return m ? (m[1] === "inf" ? 99 : +m[1]) : 0; };
  const png = (input, n, out) => ff("-i", input, "-vf", `select=eq(n\\,${n}),scale=1280:720:flags=bicubic`, "-frames:v", "1", "-vsync", "0", out);
  for (const [F, map] of [[30, (i) => i], [24, (i) => Math.round(i * 30 / 24)]]) {
    await VFL.record(ph, by, { project: `cad${F}`, sequence: "Main", clips: [clip(0, 2, 0, 30)], total: 2, fps: F }, { lg: true }); const { v } = await VFL.open(ph, { project: `cad${F}`, sequence: "Main" }), file = path.join(tmp, `cad${F}.mp4`); writeVirtual(v, file);
    for (const i of [3, 10, 17, 22]) { png(file, i, path.join(tmp, "a.png")); const scores = [-2, -1, 0, 1, 2].map((d) => { png(SRC[30], map(i) + d, path.join(tmp, "b.png")); return [d, psnr(path.join(tmp, "a.png"), path.join(tmp, "b.png"))]; }); const best = scores.reduce((x, y) => (y[1] > x[1] ? y : x));
      assert.equal(best[0], 0, `${F} fps, output frame ${i}: best match is source frame ${map(i) + best[0]}, expected ${map(i)} (${JSON.stringify(scores.map(([d, p]) => [d, +p.toFixed(1)]))})`); }
  }
});

test("FALSE IF: the rate is not part of the recipe: leaving it out equals 24, 30 gives another recipe that records fps and the frame count, and a rebuild from the recipe alone with an empty cache is identical at 30 fps", async () => {
  const c = mkClips(30), a = VFL.recipeOf(c, total, { lg: true, audio: true }).id, b = VFL.recipeOf(c, total, { lg: true, audio: true, fps: 24 }).id, d = VFL.recipeOf(c, total, { lg: true, audio: true, fps: 30 }).id;
  assert.equal(a, b); assert.notEqual(a, d);
  const e = ph.L.P.fold(ph.reader(), { kind: "vfile" }).entries.find((x) => x.body.project === "f30").body; assert.equal(e.fps, 30); assert.equal(e.frames, 180);
  fs.rmSync(CACHE, { recursive: true, force: true }); const r = await VFL.check(ph, by, { project: "f30", sequence: "Main" }, { deep: true }); assert.equal(r.status, "identical", JSON.stringify({ e: r.expected, f: r.found })); assert.ok(r.made > 0);
});

test("FALSE IF: bad rates are accepted: 29.97, a rate that does not divide 48000, 0, and a rate above 120 are refused with their own code; the all-intra fold refuses any rate but 24", async () => {
  for (const fps of [29.97, 7, 0.5, 1000]) await assert.rejects(VFL.record(ph, by, { project: "bad", sequence: "Main", clips: mkClips(30), total, fps }, { lg: true, build: false }), (e) => e.code === "bad_fps", `fps ${fps}`);
  await assert.rejects(VFL.record(ph, by, { project: "bad", sequence: "Main", clips: mkClips(30), total, fps: 30 }, { lg: false, build: false }), (e) => e.code === "bad_fps"); assert.throws(() => VFL.recipeOf(mkClips(30), total, { fps: 30 }), (e) => e.code === "bad_fps");
  await VFL.record(ph, by, { project: "ok24", sequence: "Main", clips: mkClips(30), total, fps: 24 }, { lg: false, build: false });
});

test("FALSE IF: one rate poisons another: building the same edit at 24, then 30, then 24 again gives the 24 fps file identical to the first, and the two rates cache in different folders", async () => {
  const c = [clip(0, 3, 0.9, 30)], h = async (fps, name) => { const r = await VFL.record(ph, by, { project: name, sequence: "Main", clips: c, total: 3, fps }, { lg: true, deep: true }); return PF_hash(name); };
  const PF_hash = (name) => ph.L.P.fold(ph.reader(), { kind: "vfile" }).entries.filter((x) => x.body.project === name).at(-1).body.file_sha256;
  const a = await h(24, "iso24a"); await h(30, "iso30"); fs.rmSync(path.join(CACHE, "lg2"), { recursive: true, force: true }); const b = await h(24, "iso24b");
  assert.equal(a, b); assert.notEqual(LGF.chunkPath("m", "", 0, 24), LGF.chunkPath("m", "", 0, 30)); assert.ok(fs.existsSync(path.join(CACHE, "lg2f30")), "the 30 fps chunks are in their own folder");
});

test("FALSE IF: batching differs at other rates: chunks made 3 at a time are identical, frame by frame, to the same chunks made one at a time, at 25 and at 30 fps", async () => {
  for (const [F, k] of [[25, 25], [30, 30]]) {
    const src = SRC[k], single = []; for (let n = 0; n < 2; n++) single.push(packets(await LGF.makeChunk(src, ESS[k] + "S" + F, "", n, F)));
    const outs = await LGF.makeChunks(src, ESS[k] + "B" + F, "", 0, 2, F); for (let n = 0; n < 2; n++) { assert.equal(single[n].length, F * 4, `${F} fps chunk has ${F * 4} frames`); assert.deepEqual(packets(outs[n]), single[n], `${F} fps chunk ${n}`); }
  }
});

test("FALSE IF: the CLI picks the wrong rate: --lg follows the first clip's own source (30 -> 30, 25 -> 25, 29.97 -> 30), --fps wins, no --lg stays 24, and --fps 30 without --lg is refused", () => {
  assert.equal(sourceFps(SRC[30]), 30); assert.equal(sourceFps(SRC[25]), 25); assert.equal(sourceFps(SRC[2997]), 30); assert.equal(sourceFps(path.join(tmp, "nope")), null);
  const pp = new Pharos({ dir: path.join(tmp, "ph-cli"), lib }), w = lib.P.open(pp.name, { dir: pp.dir, writer: "slate-gui" }); lib.P.weave(w, { cell: "DEF·Figure", kind: "kind", addr: "kind:placement", body: { name: "placement", cell: "INS·Figure" }, basis: {} });
  const put = (seq, k, s, e) => lib.P.weave(w, { cell: "INS·Figure", kind: "placement", addr: `clip:${seq}:${s}`, body: { project: "c", sequence: seq, track: "V1", clip: `c${s}`, source: `s${k}`, s, e, in: 0, out: e - s, path: SRC[k] }, of: [], basis: {} });
  put("a", 30, 0, 2); put("b", 25, 0, 2); put("c", 2997, 0, 2);
  const det = (seq, o = {}) => clipsFromPlacements(pp, { project: "c", sequence: seq, ...o });
  assert.deepEqual([det("a", { detect: true }).fps, det("a", { detect: true }).fps_from], [30, "the first clip's source"]); assert.equal(det("b", { detect: true }).fps, 25); assert.equal(det("c", { detect: true }).fps, 30);
  assert.deepEqual([det("a", { detect: true, fps: 50 }).fps, det("a", { detect: true, fps: 50 }).fps_from], [50, "given"]); assert.deepEqual([det("a").fps, det("a").fps_from], [24, "default"]);
  const cli = (...a) => spawnSync("node", [path.join(import.meta.dirname, "..", "bin", "proteus.mjs"), "record", "--project", "c", ...a, "--pharos", pp.dir], { env: { ...process.env, SLATE_VFOLD_CACHE: CACHE } });
  const j = (r) => { assert.equal(r.status, 0, r.stderr.toString()); return JSON.parse(r.stdout.toString()); };
  assert.equal(j(cli("--sequence", "a", "--lg")).fps, 30); assert.equal(j(cli("--sequence", "b", "--lg")).fps, 25); assert.equal(j(cli("--sequence", "b", "--lg", "--fps", "50")).fps, 50); assert.equal(j(cli("--sequence", "a")).fps, undefined);
  const bad = cli("--sequence", "a", "--fps", "30"); assert.equal(bad.status, 1); assert.match(bad.stderr.toString(), /bad_fps/);
});
