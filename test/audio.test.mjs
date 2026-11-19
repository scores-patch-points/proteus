// Proteus audio: the fold has SOUND, cut to the sample. Each test names the way the claim could be false. Run: node --test test/audio.test.mjs
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto"; import { spawnSync, spawn } from "node:child_process";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audio-test-")), CACHE = path.join(tmp, "chunks"); process.env.SLATE_VFOLD_CACHE = CACHE;
const { loadLib, Pharos } = await import("../lib/door.mjs"); const VFL = await import("../lib/vfile.mjs"); const { essence } = await import("../lib/essence.mjs"); const { createServer } = await import("../lib/serve.mjs");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const ff = (...a) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a], { maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error("ffmpeg: " + r.stderr); return r; };
const arun = (cmd, args) => new Promise((ok) => { const p = spawn(cmd, args); const o = []; let e = ""; p.stdout.on("data", (d) => o.push(d)); p.stderr.on("data", (d) => (e += d)); p.on("close", (status) => ok({ status, stdout: Buffer.concat(o), stderr: e })); });
const AR = 48000, FR = 4, sel = (src, ss, t) => ff("-ss", String(ss), "-t", String(t), "-i", src, "-vn", "-f", "s16le", "-ar", String(AR), "-ac", "2", "-").stdout;
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
const mk = (name, expr, extra = []) => { const f = path.join(tmp, "src", name); ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=10", ...(expr ? ["-f", "lavfi", "-i", `aevalsrc=${expr}:s=${extra[0] || AR}:d=10`] : []), "-c:v", "libx264", "-g", "48", "-pix_fmt", "yuv420p", ...(expr ? ["-c:a", "pcm_s16le"] : []), f); return f; };
const A = mk("a.mov", "sin(2*PI*(300+40*t)*t)|sin(2*PI*(500+25*t)*t)"), B = mk("b.mov", "0.8*sin(2*PI*(900+10*t)*t)|0.5*sin(2*PI*(1300+5*t)*t)"), NOA = mk("noaudio.mov", null), C441 = mk("c.mov", "sin(2*PI*(700+30*t)*t)|sin(2*PI*(200+60*t)*t)", [44100]);
const [eA, eB, eN, eC] = [A, B, NOA, C441].map((f) => essence(f, { persist: false }));
const ph = new Pharos({ dir: path.join(tmp, "ph"), lib: await loadLib() }), by = "operator:tester";
const clip = (s, e, inn, media, p) => ({ s, e, in: inn, media, path: p, crop: "" });
// a: 0-2 from A at 0.5 s; a GAP 2-3; b: 3-6 from B at 1.2125 s (not on the frame grid); c: 6-8 from A at 3.9 s (crosses the 4.0 s chunk boundary); d: 8-9 from a source with NO audio
const clips = () => [clip(0, 2, 0.5, eA, A), clip(3, 6, 1.2125, eB, B), clip(6, 8, 3.9, eA, A), clip(8, 9, 0, eN, NOA)], total = 9;
const expected = () => { const N = total * AR * FR, b = Buffer.alloc(N); const put = (s, d) => d.copy(b, s * AR * FR, 0, Math.min(d.length, N - s * AR * FR));
  put(0, sel(A, 0.5, 2)); put(3, sel(B, 1.2125, 3)); put(6, sel(A, 3.9, 2)); return b; };
const writeVirtual = (v, f) => { const fd = fs.openSync(f, "w"); try { for (const b of VFL.VF.readRange(v, 0, v.size - 1)) fs.writeSync(fd, b); } finally { fs.closeSync(fd); } };
const audioOf = (f) => ff("-i", f, "-vn", "-f", "s16le", "-ar", String(AR), "-ac", "2", "-").stdout;
const rec = await VFL.record(ph, by, { project: "a", sequence: "Main", clips: clips(), total }, { audio: true, deep: true });
const { v } = await VFL.open(ph, { project: "a", sequence: "Main" }, { deep: true }); const vf = path.join(tmp, "virtual.mp4"); writeVirtual(v, vf);

test("FALSE IF: the sound is not the edit's sound: the file's audio must equal, byte for byte, what cutting the same spans directly out of the sources gives (gap and no-audio clip silent, a 1.2125 s start off the frame grid, a clip across a chunk boundary)", () => {
  const got = audioOf(vf), want = expected(); assert.equal(got.length, want.length, "sample count");
  if (!got.equals(want)) { let i = 0; while (got[i] === want[i]) i++; assert.fail(`first differing byte ${i} (sample ${Math.floor(i / FR)} = ${(i / FR / AR).toFixed(4)} s) of ${want.length}`); }
});

test("FALSE IF: sound and picture disagree: both streams are 9.000 s, 216 frames and 432000 samples, and the file is a real mp4 with an audio track", () => {
  const p = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,duration,nb_read_frames,sample_rate,channels", "-of", "json", vf]).stdout), s = Object.fromEntries(p.streams.map((x) => [x.codec_type, x]));
  assert.equal(+s.video.duration, 9); assert.equal(s.video.nb_read_frames, "216"); assert.equal(+s.audio.duration, 9); assert.equal(s.audio.sample_rate, "48000"); assert.equal(s.audio.channels, 2); assert.equal(s.audio.codec_name, "pcm_s16le");
  assert.equal(audioOf(vf).length / FR, 9 * AR);
});

test("FALSE IF: the gap and the no-audio source are not silence", () => {
  const got = audioOf(vf), z = (a, b) => got.subarray(a * AR * FR, b * AR * FR).every((x) => x === 0);
  assert.ok(z(2, 3), "gap 2-3 s"); assert.ok(z(8, 9), "no-audio clip 8-9 s"); assert.ok(!z(0, 2) && !z(3, 6) && !z(6, 8), "and the clips are not silent");
});

test("FALSE IF: it is not deterministic: delete every cached chunk, rebuild from the recorded recipe, and the whole file (picture and sound) hashes the same; a check says identical", async () => {
  fs.rmSync(CACHE, { recursive: true, force: true });
  const r = await VFL.check(ph, by, { project: "a", sequence: "Main" }, { deep: true }); assert.equal(r.status, "identical", JSON.stringify({ e: r.expected, f: r.found })); assert.ok(r.made > 0, "chunks were rebuilt");
});

test("FALSE IF: the sound is free: the audio recipe must differ from the picture-only recipe of the same edit, and it records which projector made it", () => {
  assert.notEqual(VFL.recipeOf(clips(), total, { audio: true }).id, VFL.recipeOf(clips(), total).id);
  const e = ph.L.P.fold(ph.reader(), { kind: "vfile" }).entries.at(-1).body; assert.equal(e.projector, VFL.AV_PROJECTOR); assert.deepEqual(e.audio, { rate: 48000, ch: 2, fmt: "s16le", chunk: 4 });
});

test("FALSE IF: a different sample rate breaks it: a 44.1 kHz source is resampled; measured, with a bound (the resampler's start-up at a chunk edge is the risk)", () => {
  const cs = [clip(0, 2, 3.5, eC, C441)], r = spawnSync("true"); void r;
  return VFL.record(ph, by, { project: "c", sequence: "Main", clips: cs, total: 2 }, { audio: true }).then(async () => {
    const { v: v2 } = await VFL.open(ph, { project: "c", sequence: "Main" }), f = path.join(tmp, "c.mp4"); writeVirtual(v2, f);
    const got = audioOf(f), want = sel(C441, 3.5, 2); assert.equal(got.length, want.length);
    let max = 0, sum = 0; const n = want.length / 2; for (let i = 0; i < n; i++) { const d = Math.abs(got.readInt16LE(2 * i) - want.readInt16LE(2 * i)); sum += d; if (d > max) max = d; }
    console.log(`# 44.1 kHz source, crossing a chunk edge: mean abs error ${(sum / n).toFixed(2)}, max ${max} (of 32768)`); assert.ok(sum / n < 100, `mean abs error ${sum / n}`);
  });
});

test("FALSE IF: over HTTP the sound is different: whole-file sha256 over the wire equals the ledger's, random ranges match, ffmpeg decodes the audio, ffmpeg seek into the second half works", async () => {
  await VFL.record(ph, by, { project: "a", sequence: "Main", clips: clips(), total }, { audio: true, deep: true });
  const srv = createServer(ph); await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); const cur = ph.L.P.fold(ph.reader(), { kind: "vfile" }).entries.find((e) => e.body.project === "a").body, url = `http://127.0.0.1:${srv.address().port}/v/${cur.recipe.slice(0, 16)}.mp4`;
  try {
    const body = Buffer.from(await (await fetch(url)).arrayBuffer()); assert.equal(crypto.createHash("sha256").update(body).digest("hex"), cur.file_sha256);
    let seed = 3; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; for (let i = 0; i < 100; i++) { const a = Math.floor(rnd() * body.length), b = Math.min(body.length - 1, a + Math.floor(rnd() ** 3 * 2e6)); const r = await fetch(url, { headers: { range: `bytes=${a}-${b}` } }); assert.ok(Buffer.from(await r.arrayBuffer()).equals(body.subarray(a, b + 1)), `range ${a}-${b}`); }
    const d = await arun("ffmpeg", ["-v", "error", "-i", url, "-f", "null", "-"]); assert.equal(d.status, 0); assert.equal(d.stderr.trim(), "");
    const s = await arun("ffmpeg", ["-v", "error", "-ss", "6.5", "-i", url, "-vn", "-t", "1", "-f", "s16le", "-ar", "48000", "-ac", "2", "-"]), want = sel(A, 3.9 + 0.5, 1); assert.equal(s.status, 0); assert.ok(s.stdout.equals(want), "seeked sound equals the source at the matching time");
  } finally { srv.close(); }
});
