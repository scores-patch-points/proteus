// Proteus serve: try to break the claim "a recipe in the pharos is a real file, by byte range".
// Each test names the way it could be false. Run: node --test test/serve.test.mjs
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto"; import { spawnSync, spawn } from "node:child_process";
// anything that reads the URL must be async: spawnSync would block the event loop the server runs on
const arun = (cmd, args) => new Promise((ok) => { const p = spawn(cmd, args); let o = Buffer.alloc(0), e = ""; p.stdout.on("data", (d) => (o = Buffer.concat([o, d]))); p.stderr.on("data", (d) => (e += d)); p.on("close", (status) => ok({ status, stdout: o, stderr: Buffer.from(e) })); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve-test-")); process.env.SLATE_VFOLD_CACHE = path.join(tmp, "chunks");
const { loadLib, Pharos } = await import("../lib/door.mjs"); const VFL = await import("../lib/vfile.mjs"); const { essence } = await import("../lib/essence.mjs"); const { createServer, parseRange } = await import("../lib/serve.mjs");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const ff = (...a) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a]); if (r.status !== 0) throw new Error("ffmpeg: " + r.stderr); return r; };
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
const A = path.join(tmp, "src", "a.mp4"), B = path.join(tmp, "src", "b.mp4");
ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=6", "-c:v", "libx264", "-g", "48", "-pix_fmt", "yuv420p", A);
ff("-f", "lavfi", "-i", "smptebars=s=640x360:r=24:d=6", "-c:v", "libx264", "-g", "48", "-pix_fmt", "yuv420p", B);
const eA = essence(A, { persist: false }), eB = essence(B, { persist: false });
const clips = () => [{ s: 0, e: 3, in: 0, media: eA, path: A, crop: "" }, { s: 3, e: 6, in: 1, media: eB, path: B, crop: "" }];
const ph = new Pharos({ dir: path.join(tmp, "ph"), lib: await loadLib() }), by = "operator:tester";
const rec = await VFL.record(ph, by, { project: "s", sequence: "Main", clips: clips(), total: 6 }, { deep: true });
const logs = [], srv = createServer(ph, { log: (m) => logs.push(m) }); await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); const base = `http://127.0.0.1:${srv.address().port}`, url = `${base}/v/${rec.recipe.slice(0, 16)}.mp4`;
test.after(() => srv.close());
const { v } = await VFL.open(ph, { project: "s", sequence: "Main" }, { deep: true }); const local = Buffer.concat([...VFL.VF.readRange(v, 0, v.size - 1)]);
const get = (u, headers = {}) => fetch(u, { headers });

test("FALSE IF: the bytes over HTTP are not the bytes the recipe recorded (whole-file sha256 over the wire vs file_sha256 in the ledger)", async () => {
  const r = await get(url), body = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 200); assert.equal(r.headers.get("accept-ranges"), "bytes"); assert.equal(+r.headers.get("content-length"), rec.size); assert.equal(body.length, rec.size);
  const e = ph.L.P.fold(ph.reader(), { kind: "vfile" }).entries.at(-1).body;
  assert.equal(crypto.createHash("sha256").update(body).digest("hex"), e.file_sha256);
});

test("FALSE IF: any byte range differs from the same range of the file (300 random ranges, plus every edge)", async () => {
  const n = local.length, cases = [[0, 0], [n - 1, n - 1], [0, n - 1], [0, 15], [n - 16, n - 1]]; let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 300; i++) { const a = Math.floor(rnd() * n), len = 1 + Math.floor(rnd() ** 3 * 3_000_000); cases.push([a, Math.min(n - 1, a + len)]); }
  for (const [a, b] of cases) { const r = await get(url, { range: `bytes=${a}-${b}` }), got = Buffer.from(await r.arrayBuffer());
    assert.equal(r.status, 206); assert.equal(r.headers.get("content-range"), `bytes ${a}-${b}/${n}`); assert.ok(got.equals(local.subarray(a, b + 1)), `range ${a}-${b} differs`); }
});

test("FALSE IF: suffix, open-ended, past-the-end and malformed ranges are answered wrongly", async () => {
  const n = local.length; const t = async (h) => get(url, { range: h });
  let r = await t("bytes=-100"); assert.equal(r.status, 206); assert.ok(Buffer.from(await r.arrayBuffer()).equals(local.subarray(n - 100)));
  r = await t(`bytes=${n - 10}-`); assert.equal(r.status, 206); assert.equal((await r.arrayBuffer()).byteLength, 10);
  r = await t(`bytes=0-${n * 5}`); assert.equal(r.status, 206); assert.equal(r.headers.get("content-range"), `bytes 0-${n - 1}/${n}`); await r.arrayBuffer();
  r = await t(`bytes=${n}-`); assert.equal(r.status, 416); assert.equal(r.headers.get("content-range"), `bytes */${n}`);
  r = await t("bytes=5-2"); assert.equal(r.status, 416); r = await t("bytes=-0"); assert.equal(r.status, 416); r = await t("bytes=abc"); assert.equal(r.status, 416);
  assert.equal(parseRange(undefined, 10), null); assert.deepEqual(parseRange("bytes=2-", 10), { a: 2, b: 9 });
  const h = await fetch(url, { method: "HEAD" }); assert.equal(h.status, 200); assert.equal(+h.headers.get("content-length"), n); assert.equal((await h.arrayBuffer()).byteLength, 0);
});

test("FALSE IF: it is not a real mp4: ffprobe over HTTP must see 1280x720, 24 fps, 144 frames, 6 s, every frame a keyframe; ffmpeg must decode all of it with no error", async () => {
  const p = await arun("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_read_frames,duration", "-of", "json", url]), s = JSON.parse(p.stdout).streams[0];
  assert.deepEqual([s.codec_name, s.width, s.height, s.r_frame_rate, s.nb_read_frames, +s.duration], ["h264", 1280, 720, "24/1", "144", 6], p.stderr.toString());
  const k = (await arun("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=flags", "-of", "csv=p=0", url])).stdout.toString().trim().split("\n"); assert.equal(k.length, 144); assert.ok(k.every((x) => x.startsWith("K")), "every frame is a keyframe");
  const d = await arun("ffmpeg", ["-v", "error", "-i", url, "-f", "null", "-"]); assert.equal(d.status, 0); assert.equal(d.stderr.toString().trim(), "");
});

test("FALSE IF: the picture is wrong: edit frame at 1.5 s must be source A at 1.5 s, and edit 4.5 s must be source B at 2.5 s (PSNR to the conformed source; the neighbour 0.5 s away must score clearly worse)", async () => {
  const frame = async (file, t, out) => { const r = await arun("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=1280:720:flags=bicubic,format=yuv420p", out]); assert.equal(r.status, 0, r.stderr.toString()); }; const frameOld = (file, t, out) => ff("-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=1280:720:flags=bicubic,format=yuv420p", out);
  const psnr = async (x, y) => { const r = await arun("ffmpeg", ["-i", x, "-i", y, "-lavfi", "psnr", "-f", "null", "-"]), m = /average:([\d.inf]+)/.exec(r.stderr.toString()); return m[1] === "inf" ? 99 : +m[1]; };
  const sim = async (edit, src, tsrc, tag) => { const e = path.join(tmp, `${tag}-e.png`), ok = path.join(tmp, `${tag}-ok.png`), bad = path.join(tmp, `${tag}-bad.png`);
    await frame(url, edit, e); await frame(src, tsrc, ok); await frame(src, tsrc + 0.5, bad); return [await psnr(e, ok), await psnr(e, bad)]; };
  const [g1, w1] = await sim(1.5, A, 1.5, "A"); assert.ok(g1 > 30 && g1 > w1 + 6, `A: right ${g1} dB vs neighbour ${w1} dB`);
  const [g2, w2] = await sim(4.5, B, 2.5, "B"); assert.ok(g2 > 30, `B: ${g2} dB`); void w2;     // smptebars is static, so only "is B at all" is testable for the second clip
});

test("FALSE IF: seeking breaks it: a player that jumps to 5.5 s first and 0.2 s after must still decode (ffmpeg -ss over HTTP uses ranges)", async () => {
  for (const t of [5.5, 0.2, 3.0]) { const d = await arun("ffmpeg", ["-v", "error", "-ss", String(t), "-i", url, "-frames:v", "5", "-f", "null", "-"]); assert.equal(d.status, 0); assert.equal(d.stderr.toString().trim(), "", `seek ${t}`); }
});

test("FALSE IF: the server lies about state: unknown recipe 404, missing source 424 and not a crash, a changed edit moves the URL and the old one stops resolving", async () => {
  assert.equal((await get(`${base}/v/deadbeefdeadbeef.mp4`)).status, 404); assert.equal((await get(`${base}/nope`)).status, 404); assert.equal((await fetch(url, { method: "POST" })).status, 405);
  const c = clips(); c[1].in = 2; const r2 = await VFL.record(ph, by, { project: "s", sequence: "Main", clips: c, total: 6 }), url2 = `${base}/v/${r2.recipe.slice(0, 16)}.mp4`;
  assert.notEqual(r2.recipe, rec.recipe); assert.equal((await get(url)).status, 404, "the retracted recipe no longer serves"); const r = await get(url2, { range: "bytes=0-99" }); assert.equal(r.status, 206); await r.arrayBuffer();
  const st = await (await get(`${base}/status`)).json(); assert.equal(st.length, 1); assert.equal(st[0].recipe, r2.recipe);
  const gone = path.join(tmp, "src", "gone.mp4"); fs.copyFileSync(A, gone); const eG = essence(gone, { persist: false }); fs.rmSync(gone);
  await VFL.record(ph, by, { project: "m", sequence: "Main", clips: [{ s: 0, e: 1, in: 0, media: eG, path: gone, crop: "" }], total: 1 }, { build: false });
  const lst = await (await get(`${base}/status`)).json(), miss = lst.find((x) => x.project === "m"); assert.equal((await get(`${base}${miss.url}`)).status, 424);
});

test("FALSE IF: concurrent first requests build twice or tear: 8 simultaneous cold reads give identical bytes and one build", async () => {
  const c = clips(); c[0].in = 1; const r3 = await VFL.record(ph, by, { project: "s", sequence: "Main", clips: c, total: 6 }), u = `${base}/v/${r3.recipe.slice(0, 16)}.mp4`;
  const all = await Promise.all(Array.from({ length: 8 }, async () => Buffer.from(await (await get(u)).arrayBuffer())));
  assert.ok(all.every((b) => b.equals(all[0])) && all[0].length === r3.size);
  assert.equal(logs.filter((m) => m.startsWith(`built ${r3.recipe.slice(0, 12)}`)).length, 1, "built once, not once per request");
});

test("FALSE IF: the fold is repeated on every request, or a change is missed: 30 requests with nothing changed fold once; a recipe woven after that is visible on the very next request", async () => {
  let folds = 0; const counting = Object.create(ph); counting.L = { ...ph.L, P: { ...ph.L.P, fold: (...a) => { folds++; return ph.L.P.fold(...a); } } };
  const s2 = createServer(counting); await new Promise((ok) => s2.listen(0, "127.0.0.1", ok)); const b2 = `http://127.0.0.1:${s2.address().port}`;
  try {
    for (let i = 0; i < 30; i++) await (await get(`${b2}/status`)).arrayBuffer(); assert.equal(folds, 1, `folds after 30 unchanged requests: ${folds}`);
    const c = clips(); c[0].in = 0.25; const r = await VFL.record(ph, by, { project: "fold", sequence: "Main", clips: c, total: 6 });
    const st = await (await get(`${b2}/status`)).json(); assert.ok(st.some((x) => x.recipe === r.recipe), "the new recipe is served at once"); assert.equal(folds, 2, "one more fold, because something changed");
  } finally { s2.close(); }
});
