// lgfold.mjs: the fold of an edit with LONG-GOP picture, so the virtual file is close to the size of an ordinary render instead of ~10x it.
// vfold (all-intra) can start a clip on any frame because every frame is a keyframe. Here chunks are H.264 with a keyframe every GOP frames (closed GOP, no B-frames,
// so decode order is display order). A clip that starts mid-GOP keeps the frames back to the previous keyframe in the sample table, and an EDIT LIST tells the player
// to decode them and not show them. So a cut is still a header change: no seam is re-encoded. A clip's end needs nothing (later frames are simply not included).
// Cost: up to GOP-1 hidden frames before each clip start (half a GOP on average), and a seek lands on a keyframe and decodes forward.
// Same chunk rule as vfold (4 s of one source, conformed once, cached by essence and crop), a different cache namespace, a different projector name.
// Sound is lib/avfold.mjs's, unchanged. Assumption to check on every build: the frames of a run are contiguous in their chunk file (an ffmpeg progressive mp4 writes them so).
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { spawn } from "node:child_process";
import * as VF from "./vfold.mjs"; import * as AVF from "./avfold.mjs"; import { VfileError } from "./pfile.mjs";
const { box, full, u32, u16, MATRIX } = AVF;
export const GOP = 48, CRF = 23, PRESET = "veryfast", THREADS = 4, BATCH = 6, LV = 2;      // GOP is the 24 fps value; FMT(fps).gop is the one in use (always 2 s)
/** Everything that depends on the frame rate. The picture is conformed to ONE integer frame rate; a chunk is 4 s, a GOP is 2 s, the media timescale is 512 ticks a frame, and sound is a
 *  whole number of samples per frame (48000 / fps), so every cut lands on an integer sample. A rate that does not divide 48000 (29.97, 23.976) has no integer samples per frame and is refused. */
export function FMT(fps = 24) {
  if (!Number.isInteger(fps) || fps < 1 || fps > 120 || 48000 % fps !== 0) throw new VfileError("bad_fps", `the frame rate must be a whole number that divides 48000 (24, 25, 30, 50, 60 ...); got ${fps}. A rate like 29.97 has no whole number of samples per frame`);
  return { fps, chunk: VF.CHUNK, per: VF.CHUNK * fps, gop: 2 * fps, dur: 512, ts: 512 * fps, perFrame: 48000 / fps, w: VF.W, h: VF.H };
}
// x264 output depends on its thread count (measured: 1 thread and the default give different bytes for the same frames), so it is pinned and recorded in the recipe.
export const encId = (f) => ({ codec: "h264", preset: PRESET, crf: CRF, gop: f.gop, bf: 0, closed: true, threads: THREADS });
export const ENC_ID = encId(FMT(24));
const ENC = (f) => ["-c:v", "libx264", "-preset", PRESET, "-crf", String(CRF), "-g", String(f.gop), "-bf", "0", "-threads", String(THREADS), "-x264-params", `keyint=${f.gop}:min-keyint=${f.gop}:scenecut=0:open-gop=0`,
  "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-video_track_timescale", String(f.ts), "-an"];
const run = (args) => new Promise((ok, no) => { const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] }); let e = ""; p.stderr.on("data", (d) => (e += d)); p.on("close", (c) => (c ? no(new Error(e.slice(-300))) : ok())); });
const dir = (fps = 24) => path.join(VF.CACHE, fps === 24 ? `lg${LV}` : `lg${LV}f${fps}`);        // 24 keeps its old folder, so nothing already cached is lost; every other rate has its own
const cropKey = (crop) => (crop ? crypto.createHash("sha256").update(crop).digest("hex").slice(0, 8) : "full");
export const chunkPath = (media, crop, k, fps = 24) => path.join(dir(fps), `${media}.${cropKey(crop)}`, `${k}.mp4`);
const vf = (f, k0, crop) => `fps=${f.fps}:start_time=${k0 * f.chunk},${crop}scale=${f.w}:${f.h}:flags=bicubic,setsar=1,format=yuv420p`;
export async function makeChunk(src, media, crop, k, fps = 24) {
  const f = FMT(fps), out = chunkPath(media, crop, k, fps); if (fs.existsSync(out)) return out; fs.mkdirSync(path.dirname(out), { recursive: true }); const tmp = out + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp.mp4`;
  await run(["-y", "-loglevel", "error", "-copyts", "-ss", String(k * f.chunk), "-i", src, "-vf", vf(f, k, crop), "-frames:v", String(f.per), ...ENC(f), tmp]);
  fs.renameSync(tmp, out); return out;
}
/** Chunks k0 .. k0+n-1 of one source in ONE ffmpeg process: the source is decoded once (not once per chunk, each time from its previous keyframe) and each chunk has its own
 *  encoder instance, so its bytes do not depend on its neighbours. Measured identical, frame by frame, to making each chunk alone (batches of 2, 3, 4, 6). Only uncached chunks are passed. */
export async function makeChunks(src, media, crop, k0, n, fps = 24) {
  if (n === 1) return [await makeChunk(src, media, crop, k0, fps)];
  const f = FMT(fps), ks = Array.from({ length: n }, (_, i) => k0 + i), outs = ks.map((k) => chunkPath(media, crop, k, fps)); fs.mkdirSync(path.dirname(outs[0]), { recursive: true });
  const tag = `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp.mp4`, tmps = outs.map((o) => o + tag);
  const fc = `[0:v]${vf(f, k0, crop)},split=${n}` + ks.map((_, i) => `[b${i}]`).join("") + ks.map((_, i) => `;[b${i}]trim=start_frame=${i * f.per}:end_frame=${(i + 1) * f.per},setpts=PTS-STARTPTS[o${i}]`).join("");
  const args = ["-y", "-loglevel", "error", "-copyts", "-ss", String(k0 * f.chunk), "-i", src, "-filter_complex", fc]; ks.forEach((_, i) => args.push("-map", `[o${i}]`, "-frames:v", String(f.per), ...ENC(f), tmps[i]));
  try { await run(args); } catch (e) { for (const t of tmps) fs.rmSync(t, { force: true }); throw e; }
  outs.forEach((o, i) => fs.renameSync(tmps[i], o)); return outs;
}
/** the work to do for a set of needed chunks: uncached ones, grouped into runs of consecutive chunks of the same source (at most `batch` per process) */
export function groups(need, batch = BATCH, fps = 24) {
  const by = new Map(); for (const c of need) { if (fs.existsSync(chunkPath(c.media, c.crop, c.k, fps))) continue; const g = `${c.src}\0${c.media}\0${c.crop}`; (by.get(g) || by.set(g, []).get(g)).push(c); }
  const out = []; for (const cs of by.values()) { cs.sort((a, b) => a.k - b.k); let run = []; for (const c of cs) { if (run.length && (c.k !== run.at(-1).k + 1 || run.length >= batch)) { out.push(run); run = []; } run.push(c); } if (run.length) out.push(run); }
  return out;
}
export async function blackChunk(fps = 24) {
  const f = FMT(fps), out = path.join(dir(fps), "black.mp4"); if (fs.existsSync(out)) return out; fs.mkdirSync(path.dirname(out), { recursive: true }); const tmp = out + `.${process.pid}.tmp.mp4`;
  await run(["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=${f.w}x${f.h}:r=${f.fps}`, "-frames:v", "2", "-vf", "setsar=1,format=yuv420p", ...ENC(f), tmp]); fs.renameSync(tmp, out); return out;
}

/** which chunk and which frame of it every edit frame shows, at this frame rate (vfold's plan, with the rate as a parameter). Frames outside any clip are null (black). */
export function plan(clips, total, fps = 24) {
  const f = FMT(fps), fr = [], need = new Map(); let cur = 0; const n = Math.round(total * f.fps);
  for (const c of [...clips].sort((a, b) => a.s - b.s)) {
    const f0 = Math.round(c.s * f.fps), f1 = Math.min(n, Math.round(c.e * f.fps));
    for (; cur < f0 && cur < n; cur++) fr.push(null);
    for (let i = Math.max(cur, f0); i < f1; i++) {
      const t = +c.in + (i - f0) / f.fps; let k = Math.floor(t / f.chunk + 1e-9), j = Math.round((t - k * f.chunk) * f.fps); if (j >= f.per) { k++; j -= f.per; }
      const key = `${c.media}|${c.crop}|${k}`; if (!need.has(key)) need.set(key, { src: c.path, media: c.media, crop: c.crop, k }); fr.push({ key, k, j });
    }
    cur = Math.max(cur, f1);
  }
  for (; cur < n; cur++) fr.push(null);
  return { frames: fr, need };
}

/** edit frames (from vfold's plan) -> runs: a run is consecutive frames of one chunk (decoded from its keyframe g0, shown from j0 to j1), or a gap of black */
export function runsOf(frames, lens, gop = GOP) {
  const runs = [];
  for (const x of frames) {
    const last = runs.at(-1);
    if (!x) { if (last && last.gap) last.n++; else runs.push({ gap: true, n: 1 }); continue; }
    const j = Math.min(x.j, lens.get(x.key) - 1);      // past the end of a short last chunk: repeat its last frame (as vfold does); a repeat starts its own run
    if (last && !last.gap && last.key === x.key && j === last.j1 && x.j === last.xj1) { last.j1++; last.xj1++; }
    else runs.push({ key: x.key, j0: j, j1: j + 1, xj1: x.j + 1, g0: Math.floor(j / gop) * gop });
  }
  return runs;
}

/** the virtual file: { size, header, pieces, frames, chunks, hidden (frames kept only to start a clip), runs } */
export function assemble(pl, chunkFiles, black, audio = null, fps = 24) {
  const F0 = FMT(fps), info = new Map(); for (const [key, f] of chunkFiles) info.set(key, VF.readFrames(f)); const bk = VF.readFrames(black);
  const runs = runsOf(pl.frames, new Map([...info].map(([k, f]) => [k, f.frames.length])), F0.gop);
  const samples = [], pieces = [], edits = []; let pay = 0, hidden = 0;
  for (const r of runs) {
    const base = samples.length;
    if (r.gap) { const [o, s] = bk.frames[0]; pieces.push({ file: bk.file, off: o, len: s, rel: pay }); for (let i = 0; i < r.n; i++) samples.push({ size: s, rel: pay, sync: true }); edits.push([base * F0.dur, r.n * F0.dur]); pay += s; continue; }
    const F = info.get(r.key), fr = F.frames.slice(r.g0, r.j1), start = fr[0][0];
    for (let i = 1; i < fr.length; i++) if (fr[i][0] !== fr[i - 1][0] + fr[i - 1][1]) throw new Error(`lgfold: frames of ${path.basename(F.file)} are not contiguous (frame ${r.g0 + i}); this chunk was not written progressively`);
    const len = fr[fr.length - 1][0] + fr[fr.length - 1][1] - start; pieces.push({ file: F.file, off: start, len, rel: pay });
    fr.forEach((f, i) => samples.push({ size: f[1], rel: pay + (f[0] - start), sync: (r.g0 + i) % F0.gop === 0 })); hidden += r.j0 - r.g0;
    edits.push([(base + (r.j0 - r.g0)) * F0.dur, (r.j1 - r.j0) * F0.dur]); pay += len;
  }
  // consecutive edit entries that are contiguous in the media timeline play as one
  const el = []; let mt = 0; for (const [m, d] of edits) { const l = el.at(-1); if (l && l[0] + l[1] === m) l[1] += d; else el.push([m, d]); } void mt;
  const nfr = pl.frames.length, dispDur = nfr * F0.dur, mediaDur = samples.length * F0.dur;
  // sound runs follow the picture payload
  const L = audio ? AVF.layoutAudio(audio.ap, audio.files, audio.silence, pay) : null;
  const total = L ? L.end : pay;
  const moov = (hdr) => {
    const mvhd = full("mvhd", 0, 0, u32(0, 0, F0.ts, dispDur, 0x10000), Buffer.from([1, 0]), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(audio ? 3 : 2));
    const co = Buffer.alloc(8 * samples.length), sz = Buffer.alloc(4 * samples.length); samples.forEach((x, i) => { co.writeBigUInt64BE(BigInt(hdr + x.rel), 8 * i); sz.writeUInt32BE(x.size, 4 * i); });
    const sync = samples.map((x, i) => (x.sync ? i + 1 : 0)).filter(Boolean), stss = Buffer.alloc(4 * sync.length); sync.forEach((n, i) => stss.writeUInt32BE(n, 4 * i));
    const elst = Buffer.alloc(12 * el.length); el.forEach(([m, d], i) => { elst.writeUInt32BE(d, 12 * i); elst.writeInt32BE(m, 12 * i + 4); elst.writeUInt16BE(1, 12 * i + 8); elst.writeUInt16BE(0, 12 * i + 10); });
    const stbl = box("stbl", bk.stsd, full("stts", 0, 0, u32(1, samples.length, F0.dur)), full("stss", 0, 0, u32(sync.length), stss), full("stsc", 0, 0, u32(1, 1, 1, 1)), full("stsz", 0, 0, u32(0, samples.length), sz), full("co64", 0, 0, u32(samples.length), co));
    const vtrak = box("trak", full("tkhd", 0, 3, u32(0, 0, 1, 0, dispDur), Buffer.alloc(8), Buffer.alloc(8), MATRIX, u32(VF.W << 16, VF.H << 16)), box("edts", full("elst", 0, 0, u32(el.length), elst)),
      box("mdia", full("mdhd", 0, 0, u32(0, 0, F0.ts, mediaDur), Buffer.from([0x55, 0xc4, 0, 0])), full("hdlr", 0, 0, u32(0), Buffer.from("vide"), Buffer.alloc(12), Buffer.from("slate lgfold\0")),
        box("minf", full("vmhd", 0, 1, Buffer.alloc(8)), box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))), stbl)));
    return box("moov", mvhd, vtrak, ...(audio ? [AVF.audioTrak(audio.ap.N, L.aRel.map((r) => hdr + r), L.aLens, dispDur)] : []));
  };
  const ftyp = box("ftyp", Buffer.from("isom"), u32(0x200), Buffer.from("isomiso2avc1mp41")), hdrLen = ftyp.length + moov(0).length + 16, mv = moov(hdrLen);
  const mdatH = Buffer.alloc(16); mdatH.writeUInt32BE(1); mdatH.write("mdat", 4, "latin1"); mdatH.writeBigUInt64BE(BigInt(16 + total), 8);
  const header = Buffer.concat([ftyp, mv, mdatH]), out = []; for (const p of pieces) out.push({ file: p.file, at: header.length + p.rel, off: p.off, len: p.len });
  if (L) for (const x of L.pieces) out.push({ file: x.file, at: header.length + x.rel, off: x.off, len: x.len });
  return { size: header.length + total, header, pieces: out, frames: nfr, fps, chunks: new Set(runs.filter((r) => !r.gap).map((r) => r.key)).size, hidden, runs: runs.length, edits: el.length, ...(audio ? { audio_runs: audio.ap.runs.length, audio_samples: audio.ap.N } : {}) };
}

/** make every chunk (picture, and sound if asked) the edit needs, in parallel, then assemble. `fps` is the frame rate the picture is conformed to (a whole number dividing 48000). */
export async function lgfold(clips, total, { audio = false, aclips = null, fps = 24, workers = 6, batch = BATCH, onChunk = () => {} } = {}) {
  const t0 = Date.now(), f = FMT(fps), pl = plan(clips, total, fps), ap = audio ? AVF.planAudio(aclips || clips, total, fps) : null;
  const todo = [...groups([...pl.need.values()], batch, fps).map((g) => async () => { await makeChunks(g[0].src, g[0].media, g[0].crop, g[0].k, g.length, fps); return g.length; }),
    ...(ap ? [...ap.need.values()].filter((c) => !fs.existsSync(AVF.audioChunkPath(c.media, c.k))).map((c) => async () => { await AVF.makeAudioChunk(c.src, c.media, c.k); return 1; }) : [])];
  const q = [...todo]; let made = 0; await Promise.all(Array.from({ length: workers }, async () => { while (q.length) { const n = await q.shift()(); made += n; onChunk(made); } }));
  const files = new Map([...pl.need.entries()].map(([key, c]) => [key, chunkPath(c.media, c.crop, c.k, fps)]));
  const v = assemble(pl, files, await blackChunk(fps), ap && { ap, files: new Map([...ap.need.entries()].map(([key, c]) => [key, AVF.audioChunkPath(c.media, c.k)])), silence: AVF.silenceChunk() }, fps); v.ms = Date.now() - t0; v.made = made; void f; return v;
}
