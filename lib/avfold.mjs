// avfold.mjs: the fold of an edit with SOUND. Picture is vfold's (cached all-intra chunks, a computed sample table). Sound is raw PCM (48 kHz, stereo, 16-bit,
// 'sowt'), because PCM is the one audio form that can be cut to the exact sample with no priming, no overlap and no re-encode: the edit's audio is just runs of
// bytes from cached per-source chunks, and the audio sample table is one chunk-offset entry per run. Audio chunks are 4 s of conformed source sound, cached by
// (essence, index); a run never crosses a chunk, and the file holds only the bytes the edit uses (nothing is over-provisioned).
// Picture and sound share the clip's `s`, `e` and `in`. Picture lands on the 24 fps grid (each frame is 2000 samples), sound starts at the clip's exact `in`.
// A gap in the picture is black and a gap in the sound is silence. A source with no audio stream gives silence.
// Layout: ftyp, moov, one mdat holding the picture payload then the sound runs. Not interleaved, so a player reads the tail for sound (fine over range requests).
import fs from "node:fs"; import path from "node:path"; import { spawn } from "node:child_process";
import * as VF from "./vfold.mjs";
export const AR = 48000, CH = 2, BPF = CH * 2, PER_FRAME = AR / VF.FPS, ACHUNK = VF.CHUNK * AR, AV = 1;     // 2000 samples per picture frame; 192000 samples per chunk
const apath = (media, k) => path.join(VF.CACHE, `v${VF.V}`, `audio${AV}`, `${media}.${k}.pcm`);
export const audioChunkPath = apath;
const silencePath = () => path.join(VF.CACHE, `v${VF.V}`, `audio${AV}`, "silence.pcm");
const run = (args) => new Promise((ok) => { const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] }); let e = ""; p.stderr.on("data", (d) => (e += d)); p.on("close", (c) => ok({ code: c, err: e.slice(-300) })); });
const HAS = new Map();   // source path -> does it have an audio stream (a source file does not change under its essence id; the path is only a hint)
const hasAudio = (src) => HAS.get(src) || HAS.set(src, new Promise((ok) => { const p = spawn("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", src]); let o = ""; p.stdout.on("data", (d) => (o += d)); p.on("close", (c) => ok(c === 0 && o.trim() !== ""));  })).get(src);
/** a 4 s chunk of the source's sound, conformed. Always exactly ACHUNK*BPF bytes: short sources and sources with no audio are padded with silence. */
export async function makeAudioChunk(src, media, k) {
  const out = apath(media, k); if (fs.existsSync(out)) return out; fs.mkdirSync(path.dirname(out), { recursive: true }); const tmp = out + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  if (await hasAudio(src)) { const r = await run(["-y", "-loglevel", "error", "-ss", String(k * VF.CHUNK), "-i", src, "-vn", "-map", "0:a:0", "-t", String(VF.CHUNK), "-af", `aresample=${AR},aformat=sample_fmts=s16:channel_layouts=stereo`, "-f", "s16le", tmp]);
    if (r.code !== 0) { fs.rmSync(tmp, { force: true }); throw new Error("audio chunk: " + r.err); } }
  const want = ACHUNK * BPF, have = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
  if (have < want) { const fd = fs.openSync(tmp, "a"); try { fs.writeSync(fd, Buffer.alloc(want - have)); } finally { fs.closeSync(fd); } } else if (have > want) fs.truncateSync(tmp, want);
  fs.renameSync(tmp, out); return out;
}
export function silenceChunk() { const out = silencePath(); if (fs.existsSync(out)) return out; fs.mkdirSync(path.dirname(out), { recursive: true }); const tmp = out + `.${process.pid}.tmp`; fs.writeFileSync(tmp, Buffer.alloc(ACHUNK * BPF)); fs.renameSync(tmp, out); return out; }

/** clips -> runs of sound in edit order: { key, off (bytes in chunk), n (samples) } or { silence: true, n }. Covers exactly total*AR samples. */
export function planAudio(clips, total) {
  const nf = Math.round(total * VF.FPS), N = nf * PER_FRAME, runs = [], need = new Map(); let cur = 0;
  const sil = (len) => { while (len > 0) { const m = Math.min(len, ACHUNK); runs.push({ silence: true, off: 0, n: m }); len -= m; } };
  for (const c of [...clips].sort((a, b) => a.s - b.s)) {
    const a0 = Math.round(c.s * VF.FPS) * PER_FRAME, a1 = Math.min(N, Math.round(c.e * VF.FPS) * PER_FRAME), start = Math.max(cur, a0); if (a1 <= start) continue;
    sil(start - cur); let pos = start, sp = Math.round(+c.in * AR) + (start - a0);
    while (pos < a1) { const k = Math.floor(sp / ACHUNK), off = sp - k * ACHUNK, m = Math.min(a1 - pos, ACHUNK - off), key = `${c.media}|${k}`;
      if (!need.has(key)) need.set(key, { src: c.path, media: c.media, k }); runs.push({ key, off: off * BPF, n: m }); pos += m; sp += m; }
    cur = a1;
  }
  sil(N - cur); return { runs, need, N };
}

// ---- boxes (copied from vfold: its writer is not exported; the video trak below is the same bytes)
export const box = (t, ...parts) => { const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(t, 4, "latin1"); return Buffer.concat([h, body]); };
export const full = (t, v, f, ...parts) => { const h = Buffer.alloc(4); h.writeUInt32BE((v << 24) | f); return box(t, h, ...parts); };
export const u32 = (...xs) => { const b = Buffer.alloc(4 * xs.length); xs.forEach((x, i) => b.writeUInt32BE(x >>> 0, 4 * i)); return b; };
export const u16 = (...xs) => { const b = Buffer.alloc(2 * xs.length); xs.forEach((x, i) => b.writeUInt16BE(x, 2 * i)); return b; };
export const MATRIX = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
/** the sound trak: QuickTime v0 'sowt' (16-bit little-endian PCM). One sample = one frame of 2 channels; sample size is fixed, so no per-sample table: one chunk offset per run. mdur is the movie duration in the movie timescale. */
export function audioTrak(N, aOffs, aLens, ms) {
  const sowt = box("sowt", Buffer.alloc(6), u16(1), u16(0, 0), u32(0), u16(CH, 16, 0, 0), u32(AR * 65536));
  const stsc = []; let prev = -1; aLens.forEach((n, i) => { if (n !== prev) { stsc.push(i + 1, n, 1); prev = n; } });
  const aco = Buffer.alloc(8 * aOffs.length); aOffs.forEach((o, i) => aco.writeBigUInt64BE(BigInt(o), 8 * i));
  const astbl = box("stbl", full("stsd", 0, 0, u32(1), sowt), full("stts", 0, 0, u32(1, N, 1)), full("stsc", 0, 0, u32(stsc.length / 3), u32(...stsc)), full("stsz", 0, 0, u32(BPF, N)), full("co64", 0, 0, u32(aOffs.length), aco));
  const atrak = box("trak", full("tkhd", 0, 3, u32(0, 0, 2, 0, ms), Buffer.alloc(8), Buffer.from([0, 0, 0, 0, 1, 0, 0, 0]), MATRIX, u32(0, 0)),
    box("mdia", full("mdhd", 0, 0, u32(0, 0, AR, N), Buffer.from([0x55, 0xc4, 0, 0])), full("hdlr", 0, 0, u32(0), Buffer.from("soun"), Buffer.alloc(12), Buffer.from("slate afold\0")),
      box("minf", full("smhd", 0, 0, Buffer.alloc(4)), box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))), astbl)));
  return atrak;
}
function moovAV(nfr, vsizes, voffs, vstsd, N, aOffs, aLens) {
  const { FPS, TS, DUR, W, H } = VF, dur = nfr * DUR, ms = Math.round((nfr / FPS) * 1000);
  const mvhd = full("mvhd", 0, 0, u32(0, 0, 1000, ms, 0x10000), Buffer.from([1, 0]), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(3));
  const vco = Buffer.alloc(8 * voffs.length); voffs.forEach((o, i) => vco.writeBigUInt64BE(BigInt(o), 8 * i)); const vsz = Buffer.alloc(4 * vsizes.length); vsizes.forEach((s, i) => vsz.writeUInt32BE(s, 4 * i));
  const vstbl = box("stbl", vstsd, full("stts", 0, 0, u32(1, nfr, DUR)), full("stsc", 0, 0, u32(1, 1, 1, 1)), full("stsz", 0, 0, u32(0, vsizes.length), vsz), full("co64", 0, 0, u32(voffs.length), vco));
  const vtrak = box("trak", full("tkhd", 0, 3, u32(0, 0, 1, 0, ms), Buffer.alloc(8), Buffer.alloc(8), MATRIX, u32(W << 16, H << 16)),
    box("mdia", full("mdhd", 0, 0, u32(0, 0, TS, dur), Buffer.from([0x55, 0xc4, 0, 0])), full("hdlr", 0, 0, u32(0), Buffer.from("vide"), Buffer.alloc(12), Buffer.from("slate vfold\0")),
      box("minf", full("vmhd", 0, 1, Buffer.alloc(8)), box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))), vstbl)));
  const atrak = audioTrak(N, aOffs, aLens, ms);
  return box("moov", mvhd, vtrak, atrak);
}

/** the virtual file with sound: { size, header, pieces, frames, chunks, audio_runs } */
export function assembleAV(pl, chunkFiles, black, ap, aFiles, silence) {
  const info = new Map(); for (const [key, f] of chunkFiles) info.set(key, VF.readFrames(f)); const bk = VF.readFrames(black);
  const used = [...new Set(pl.frames.filter(Boolean).map((x) => x.key))]; const files = [bk, ...used.map((k) => info.get(k))];
  const ftyp = box("ftyp", Buffer.from("isom"), u32(0x200), Buffer.from("isomiso2avc1mp41"));
  const base = new Map(); let pay = 0; for (const f of files) { base.set(f.file, pay); pay += f.mdat[1] - f.mdat[0]; }
  const sizes = [], rel = [];
  for (const x of pl.frames) { const F = x ? info.get(x.key) : bk; const j = x ? Math.min(x.j, F.frames.length - 1) : 0; const [o, s] = F.frames[j]; sizes.push(s); rel.push(base.get(F.file) + o - F.mdat[0]); }
  const aRel = [], aLens = [], aSrc = []; let ap0 = pay; for (const r of ap.runs) { aRel.push(ap0); aLens.push(r.n); aSrc.push({ file: r.silence ? silence : aFiles.get(r.key), off: r.off, len: r.n * BPF }); ap0 += r.n * BPF; }
  const total = ap0;
  let mv = moovAV(pl.frames.length, sizes, rel.map(() => 0), bk.stsd, ap.N, aRel.map(() => 0), aLens); const hdrLen = ftyp.length + mv.length + 16;
  mv = moovAV(pl.frames.length, sizes, rel.map((r) => hdrLen + r), bk.stsd, ap.N, aRel.map((r) => hdrLen + r), aLens);
  const mdatH = Buffer.alloc(16); mdatH.writeUInt32BE(1); mdatH.write("mdat", 4, "latin1"); mdatH.writeBigUInt64BE(BigInt(16 + total), 8);
  const header = Buffer.concat([ftyp, mv, mdatH]); const pieces = []; let at = header.length;
  for (const f of files) { const len = f.mdat[1] - f.mdat[0]; pieces.push({ file: f.file, at, off: f.mdat[0], len }); at += len; }
  for (const s of aSrc) { pieces.push({ file: s.file, at, off: s.off, len: s.len }); at += s.len; }
  return { size: at, header, pieces, frames: pl.frames.length, chunks: used.length, audio_runs: ap.runs.length, audio_samples: ap.N };
}

/** make every chunk (picture and sound) the edit needs, in parallel, then assemble */
export async function avfold(clips, total, { workers = 6, onChunk = () => {} } = {}) {
  const t0 = Date.now(), pl = VF.plan(clips, total), ap = planAudio(clips, total);
  const todo = [...[...pl.need.values()].filter((c) => !fs.existsSync(VF.chunkPath(c.media, c.crop, c.k))).map((c) => () => VF.makeChunk(c.src, c.media, c.crop, c.k)),
    ...[...ap.need.values()].filter((c) => !fs.existsSync(apath(c.media, c.k))).map((c) => () => makeAudioChunk(c.src, c.media, c.k))];
  const q = [...todo]; let made = 0; await Promise.all(Array.from({ length: workers }, async () => { while (q.length) { await q.shift()(); onChunk(++made, todo.length); } }));
  const vfiles = new Map([...pl.need.entries()].map(([key, c]) => [key, VF.chunkPath(c.media, c.crop, c.k)])), afiles = new Map([...ap.need.entries()].map(([key, c]) => [key, apath(c.media, c.k)]));
  const v = assembleAV(pl, vfiles, await VF.blackChunk(), ap, afiles, silenceChunk()); v.ms = Date.now() - t0; v.made = made; return v;
}
