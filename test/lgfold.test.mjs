// Proteus long-GOP fold: near-render size, cuts still a header change (edit list hides the frames before a clip's keyframe). Each test names how the claim could be false.
// Run: node --test test/lgfold.test.mjs
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto"; import { spawnSync, spawn } from "node:child_process";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lg-test-")), CACHE = path.join(tmp, "chunks"); process.env.SLATE_VFOLD_CACHE = CACHE;
const { loadLib, Pharos } = await import("../lib/door.mjs"); const VFL = await import("../lib/vfile.mjs"); const LGF = await import("../lib/lgfold.mjs"); const { essence } = await import("../lib/essence.mjs"); const { createServer } = await import("../lib/serve.mjs");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const ff = (...a) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a], { maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error("ffmpeg: " + r.stderr); return r; };
const arun = (cmd, args) => new Promise((ok) => { const p = spawn(cmd, args); const o = []; let e = ""; p.stdout.on("data", (d) => o.push(d)); p.stderr.on("data", (d) => (e += d)); p.on("close", (status) => ok({ status, stdout: Buffer.concat(o), stderr: e })); });
const AR = 48000, FR = 4, sel = (src, ss, t) => ff("-ss", String(ss), "-t", String(t), "-i", src, "-vn", "-f", "s16le", "-ar", String(AR), "-ac", "2", "-").stdout;
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
const mk = (name, expr) => { const f = path.join(tmp, "src", name); ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=10", "-f", "lavfi", "-i", `aevalsrc=${expr}:s=${AR}:d=10`, "-c:v", "libx264", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", f); return f; };
const A = mk("a.mov", "sin(2*PI*(300+40*t)*t)|sin(2*PI*(500+25*t)*t)"), B = mk("b.mov", "0.8*sin(2*PI*(900+10*t)*t)|0.5*sin(2*PI*(1300+5*t)*t)");
const [eA, eB] = [A, B].map((f) => essence(f, { persist: false }));
const clip = (s, e, inn, media, p) => ({ s, e, in: inn, media, path: p, crop: "" });
// c1 starts mid-GOP (12 hidden frames); a GAP 2-3; c2 off the frame grid; c3 crosses a chunk boundary; c4 starts at frame 46 of a GOP (46 hidden); c5 starts exactly on a keyframe; c6 continues c5 in the source (one run)
const clips = () => [clip(0, 2, 0.5, eA, A), clip(3, 6, 1.2125, eB, B), clip(6, 8, 3.9, eA, A), clip(8, 9, 1.9, eA, A), clip(9, 10, 2.0, eA, A), clip(10, 11, 3.0, eA, A)], total = 11;
const ph = new Pharos({ dir: path.join(tmp, "ph"), lib: await loadLib() }), by = "operator:tester";
const rec = await VFL.record(ph, by, { project: "l", sequence: "Main", clips: clips(), total }, { lg: true, audio: true, deep: true });
const recIntra = await VFL.record(ph, by, { project: "i", sequence: "Main", clips: clips(), total }, { audio: true });
const { v } = await VFL.open(ph, { project: "l", sequence: "Main" }, { deep: true }); const vf = path.join(tmp, "lg.mp4"); { const fd = fs.openSync(vf, "w"); for (const b of VFL.VF.readRange(v, 0, v.size - 1)) fs.writeSync(fd, b); fs.closeSync(fd); }
const md5s = (input, extra = []) => spawnSync("ffmpeg", ["-v", "error", ...extra, "-i", input, "-an", "-vf", "format=yuv420p", "-f", "framemd5", "-"], { maxBuffer: 1 << 26 }).stdout.toString().split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop().trim());
// what each edit frame SHOULD be: the decoded frame j of the chunk the plan names (or black), independent of how the source was encoded
const expectedMd5 = () => { const norm = clips().map((c) => ({ ...c })), pl = VFL.VF.plan(norm, total), cache = new Map(), get = (file) => cache.get(file) || cache.set(file, md5s(file)).get(file);
  return pl.frames.map((x) => { if (!x) return get(path.join(CACHE, `lg${LGF.LV}`, "black.mp4"))[0]; const c = pl.need.get(x.key), m = get(LGF.chunkPath(c.media, c.crop, c.k)); return m[Math.min(x.j, m.length - 1)]; }); };

test("FALSE IF: the picture is not the edit: every one of the 264 decoded frames equals, by hash, the frame the plan names in the cached chunks (mid-GOP starts, a 46-frame preroll, a keyframe start, a merged run, a chunk crossing, a black gap)", () => {
  const got = md5s(vf), want = expectedMd5(); assert.equal(got.length, want.length, `frame count (hidden frames must not be shown): got ${got.length}`);
  const bad = got.findIndex((x, i) => x !== want[i]); assert.equal(bad, -1, `first wrong frame ${bad} (${(bad / 24).toFixed(3)} s)`);
});

test("FALSE IF: the header lies: the edit list hides frames (hidden > 0), the sync table lists only real keyframes, duration is exactly 11 s, and the file is a real mp4", () => {
  assert.ok(v.hidden >= 12 + 46, `hidden frames ${v.hidden}`); assert.ok(v.edits < v.runs + 1);
  const pk = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=flags", "-of", "csv=p=0", vf]).stdout.toString().trim().split("\n");
  assert.ok(pk.filter((x) => x.startsWith("K")).length >= 6 && pk.filter((x) => x.startsWith("K")).length < pk.length / 8, "keyframes are sparse");
  const j = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,duration", "-of", "json", vf]).stdout), s = Object.fromEntries(j.streams.map((x) => [x.codec_type, x]));
  assert.deepEqual([s.video.codec_name, s.video.width, s.video.height, s.video.r_frame_rate, +s.video.duration, +s.audio.duration], ["h264", 1280, 720, "24/1", 11, 11]);
});

test("FALSE IF: it is not smaller: the long-GOP file must be well under the all-intra file of the same edit (measured, printed)", () => {
  console.log(`# same edit: long-GOP ${rec.size} bytes, all-intra ${recIntra.size} bytes, ratio ${(rec.size / recIntra.size).toFixed(3)} (synthetic testsrc2, high motion; the real hearing is in the session notes)`);
  assert.ok(rec.size < recIntra.size * 0.5, `ratio ${rec.size / recIntra.size}`);
});

test("FALSE IF: the sound broke when the picture changed: audio equals direct cuts of the sources byte for byte (c1 gap-free here; the gap 2-3 s is silence)", () => {
  const N = total * AR * FR, want = Buffer.alloc(N), put = (s, d) => d.copy(want, s * AR * FR, 0, Math.min(d.length, N - s * AR * FR));
  put(0, sel(A, 0.5, 2)); put(3, sel(B, 1.2125, 3)); put(6, sel(A, 3.9, 2)); put(8, sel(A, 1.9, 1)); put(9, sel(A, 2.0, 1)); put(10, sel(A, 3.0, 1));
  const got = ff("-i", vf, "-vn", "-f", "s16le", "-ar", String(AR), "-ac", "2", "-").stdout; assert.equal(got.length, want.length); assert.ok(got.equals(want));
});

test("FALSE IF: it is not deterministic: delete every cached chunk, rebuild, and the file hashes the same (picture and sound); a check says identical", async () => {
  fs.rmSync(CACHE, { recursive: true, force: true }); const r = await VFL.check(ph, by, { project: "l", sequence: "Main" }, { deep: true });
  assert.equal(r.status, "identical", JSON.stringify({ e: r.expected, f: r.found })); assert.ok(r.made > 0);
});

test("FALSE IF: over HTTP it differs or will not seek: whole-file hash equals the ledger's, 100 random ranges match, ffmpeg decodes it clean, and seeking to a mid-GOP time lands on the right frame", async () => {
  const srv = createServer(ph); await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); const cur = ph.L.P.fold(ph.reader(), { kind: "vfile" }).entries.find((e) => e.body.project === "l").body, url = `http://127.0.0.1:${srv.address().port}/v/${cur.recipe.slice(0, 16)}.mp4`;
  try {
    const body = Buffer.from(await (await fetch(url)).arrayBuffer()); assert.equal(crypto.createHash("sha256").update(body).digest("hex"), cur.file_sha256);
    let seed = 5; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; for (let i = 0; i < 100; i++) { const a = Math.floor(rnd() * body.length), b = Math.min(body.length - 1, a + Math.floor(rnd() ** 3 * 2e6)); const r = await fetch(url, { headers: { range: `bytes=${a}-${b}` } }); assert.ok(Buffer.from(await r.arrayBuffer()).equals(body.subarray(a, b + 1)), `range ${a}-${b}`); }
    const d = await arun("ffmpeg", ["-v", "error", "-i", url, "-f", "null", "-"]); assert.equal(d.status, 0); assert.equal(d.stderr.trim(), "");
    const want = expectedMd5();
    for (const t of [1.0, 4.5, 8.5, 9.25]) { const r = await arun("ffmpeg", ["-v", "error", "-ss", String(t), "-i", url, "-an", "-vf", "format=yuv420p", "-frames:v", "1", "-f", "framemd5", "-"]); const m = r.stdout.toString().split("\n").filter((l) => l && !l.startsWith("#"))[0].split(",").pop().trim(); assert.equal(m, want[Math.round(t * 24)], `seek to ${t} s`); }
  } finally { srv.close(); }
});

// ---- batching: one ffmpeg process makes several chunks of a source. The claim is that it changes nothing about the bytes.
const packets = (f) => spawnSync("ffmpeg", ["-v", "error", "-i", f, "-c", "copy", "-f", "framemd5", "-"], { maxBuffer: 1 << 26 }).stdout.toString().split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop().trim());
test("FALSE IF: batching changes a chunk: for sources at 24, 25 and 29.97 fps, chunks made 3 at a time are identical, frame by frame, to the same chunks made one at a time", async () => {
  const srcs = { s24: A, s25: path.join(tmp, "src", "c25.mov"), s2997: path.join(tmp, "src", "c2997.mov") };
  ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=10", "-c:v", "libx264", "-g", "50", "-pix_fmt", "yuv420p", srcs.s25); ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=30000/1001:d=10", "-c:v", "libx264", "-g", "60", "-pix_fmt", "yuv420p", srcs.s2997);
  for (const [name, src] of Object.entries(srcs)) {
    const media = essence(src, { persist: false }), single = [], batched = [];
    for (let k = 0; k < 3; k++) { const f = await LGF.makeChunk(src, media + "S", "", k); single.push(packets(f)); }                       // one process per chunk (a different essence key, so the cache keeps them apart)
    const outs = await LGF.makeChunks(src, media + "B", "", 0, 3); for (const f of outs) batched.push(packets(f));                      // one process for all three
    for (let k = 0; k < 3; k++) { assert.ok(single[k].length >= 48, `${name} chunk ${k} has frames`); assert.deepEqual(batched[k], single[k], `${name}: chunk ${k} differs when batched`); }
  }
});

test("FALSE IF: the grouping leaks into the file: the same edit built with batches of 6 and with batch size 1 gives the same file, byte for byte", async () => {
  const c = clips().map((x) => ({ ...x })), norm = c.map((x) => ({ ...x, crop: "" }));
  fs.rmSync(CACHE, { recursive: true, force: true }); const a = await LGF.lgfold(norm, total, { audio: false, batch: 6 }); const ha = crypto.createHash("sha256").update(Buffer.concat([...VFL.VF.readRange(a, 0, a.size - 1)])).digest("hex");
  fs.rmSync(CACHE, { recursive: true, force: true }); const b = await LGF.lgfold(norm, total, { audio: false, batch: 1 }); const hb = crypto.createHash("sha256").update(Buffer.concat([...VFL.VF.readRange(b, 0, b.size - 1)])).digest("hex");
  assert.equal(ha, hb); assert.ok(a.made === b.made && a.made > 0, `chunks made: ${a.made} vs ${b.made}`);
});

test("FALSE IF: grouping is wrong: only uncached chunks, only consecutive chunks of the same source, never more than the batch size", () => {
  const mkc = (src, k) => ({ src, media: "m" + src, crop: "", k }), need = [mkc("a", 0), mkc("a", 1), mkc("a", 2), mkc("a", 5), mkc("b", 3), mkc("a", 3), mkc("a", 4)];
  const g = LGF.groups(need, 3).map((r) => r.map((c) => c.src + c.k).join(","));
  assert.deepEqual(g.sort(), ["a0,a1,a2", "a3,a4,a5", "b3"].sort(), JSON.stringify(g));
});
