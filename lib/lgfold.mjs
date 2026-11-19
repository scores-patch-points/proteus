// lgfold.mjs: the fold of an edit with LONG-GOP picture, so the virtual file is close to the size of an ordinary render instead of ~10x it.
// vfold (all-intra) can start a clip on any frame because every frame is a keyframe. Here chunks are H.264 with a keyframe every GOP frames (closed GOP, no B-frames,
// so decode order is display order). A clip that starts mid-GOP keeps the frames back to the previous keyframe in the sample table, and an EDIT LIST tells the player
// to decode them and not show them. So a cut is still a header change: no seam is re-encoded. A clip's end needs nothing (later frames are simply not included).
// Cost: up to GOP-1 hidden frames before each clip start (half a GOP on average), and a seek lands on a keyframe and decodes forward.
// Same chunk rule as vfold (4 s of one source, conformed once, cached by essence and crop), a different cache namespace, a different projector name.
// Sound is lib/avfold.mjs's, unchanged. Assumption to check on every build: the frames of a run are contiguous in their chunk file (an ffmpeg progressive mp4 writes them so).
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { spawn } from "node:child_process";
import * as VF from "./vfold.mjs"; import * as AVF from "./avfold.mjs";
const { box, full, u32, u16, MATRIX } = AVF;
export const GOP = 48, CRF = 23, PRESET = "veryfast", LV = 1;
export const ENC_ID = { codec: "h264", preset: PRESET, crf: CRF, gop: GOP, bf: 0, closed: true };
const ENC = ["-c:v", "libx264", "-preset", PRESET, "-crf", String(CRF), "-g", String(GOP), "-bf", "0", "-x264-params", `keyint=${GOP}:min-keyint=${GOP}:scenecut=0:open-gop=0`,
  "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-video_track_timescale", String(VF.TS), "-an"];
const run = (args) => new Promise((ok, no) => { const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] }); let e = ""; p.stderr.on("data", (d) => (e += d)); p.on("close", (c) => (c ? no(new Error(e.slice(-300))) : ok())); });
const dir = () => path.join(VF.CACHE, `lg${LV}`);
const cropKey = (crop) => (crop ? crypto.createHash("sha256").update(crop).digest("hex").slice(0, 8) : "full");
export const chunkPath = (media, crop, k) => path.join(dir(), `${media}.${cropKey(crop)}`, `${k}.mp4`);
export async function makeChunk(src, media, crop, k) {
  const out = chunkPath(media, crop, k); if (fs.existsSync(out)) return out; fs.mkdirSync(path.dirname(out), { recursive: true }); const tmp = out + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp.mp4`;
  await run(["-y", "-loglevel", "error", "-copyts", "-ss", String(k * VF.CHUNK), "-i", src, "-vf", `fps=${VF.FPS}:start_time=${k * VF.CHUNK},${crop}scale=${VF.W}:${VF.H}:flags=bicubic,setsar=1,format=yuv420p`, "-frames:v", String(VF.PER), ...ENC, tmp]);
  fs.renameSync(tmp, out); return out;
}
export async function blackChunk() {
  const out = path.join(dir(), "black.mp4"); if (fs.existsSync(out)) return out; fs.mkdirSync(path.dirname(out), { recursive: true }); const tmp = out + `.${process.pid}.tmp.mp4`;
  await run(["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=${VF.W}x${VF.H}:r=${VF.FPS}`, "-frames:v", "2", "-vf", "setsar=1,format=yuv420p", ...ENC, tmp]); fs.renameSync(tmp, out); return out;
}

/** edit frames (from vfold's plan) -> runs: a run is consecutive frames of one chunk (decoded from its keyframe g0, shown from j0 to j1), or a gap of black */
export function runsOf(frames, lens) {
  const runs = [];
  for (const x of frames) {
    const last = runs.at(-1);
    if (!x) { if (last && last.gap) last.n++; else runs.push({ gap: true, n: 1 }); continue; }
    const j = Math.min(x.j, lens.get(x.key) - 1);      // past the end of a short last chunk: repeat its last frame (as vfold does); a repeat starts its own run
    if (last && !last.gap && last.key === x.key && j === last.j1 && x.j === last.xj1) { last.j1++; last.xj1++; }
    else runs.push({ key: x.key, j0: j, j1: j + 1, xj1: x.j + 1, g0: Math.floor(j / GOP) * GOP });
  }
  return runs;
}

/** the virtual file: { size, header, pieces, frames, chunks, hidden (frames kept only to start a clip), runs } */
export function assemble(pl, chunkFiles, black, audio = null) {
  const info = new Map(); for (const [key, f] of chunkFiles) info.set(key, VF.readFrames(f)); const bk = VF.readFrames(black);
  const runs = runsOf(pl.frames, new Map([...info].map(([k, f]) => [k, f.frames.length])));
  const samples = [], pieces = [], edits = []; let pay = 0, hidden = 0;
  for (const r of runs) {
    const base = samples.length;
    if (r.gap) { const [o, s] = bk.frames[0]; pieces.push({ file: bk.file, off: o, len: s, rel: pay }); for (let i = 0; i < r.n; i++) samples.push({ size: s, rel: pay, sync: true }); edits.push([base * VF.DUR, r.n * VF.DUR]); pay += s; continue; }
    const F = info.get(r.key), fr = F.frames.slice(r.g0, r.j1), start = fr[0][0];
    for (let i = 1; i < fr.length; i++) if (fr[i][0] !== fr[i - 1][0] + fr[i - 1][1]) throw new Error(`lgfold: frames of ${path.basename(F.file)} are not contiguous (frame ${r.g0 + i}); this chunk was not written progressively`);
    const len = fr[fr.length - 1][0] + fr[fr.length - 1][1] - start; pieces.push({ file: F.file, off: start, len, rel: pay });
    fr.forEach((f, i) => samples.push({ size: f[1], rel: pay + (f[0] - start), sync: (r.g0 + i) % GOP === 0 })); hidden += r.j0 - r.g0;
    edits.push([(base + (r.j0 - r.g0)) * VF.DUR, (r.j1 - r.j0) * VF.DUR]); pay += len;
  }
  // consecutive edit entries that are contiguous in the media timeline play as one
  const el = []; let mt = 0; for (const [m, d] of edits) { const l = el.at(-1); if (l && l[0] + l[1] === m) l[1] += d; else el.push([m, d]); } void mt;
  const nfr = pl.frames.length, dispDur = nfr * VF.DUR, mediaDur = samples.length * VF.DUR;
  // sound runs follow the picture payload
  const aRel = [], aLens = [], aSrc = []; let ap0 = pay; if (audio) for (const r of audio.ap.runs) { aRel.push(ap0); aLens.push(r.n); aSrc.push({ file: r.silence ? audio.silence : audio.files.get(r.key), off: r.off, len: r.n * AVF.BPF }); ap0 += r.n * AVF.BPF; }
  const total = ap0;
  const moov = (hdr) => {
    const mvhd = full("mvhd", 0, 0, u32(0, 0, VF.TS, dispDur, 0x10000), Buffer.from([1, 0]), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(audio ? 3 : 2));
    const co = Buffer.alloc(8 * samples.length), sz = Buffer.alloc(4 * samples.length); samples.forEach((x, i) => { co.writeBigUInt64BE(BigInt(hdr + x.rel), 8 * i); sz.writeUInt32BE(x.size, 4 * i); });
    const sync = samples.map((x, i) => (x.sync ? i + 1 : 0)).filter(Boolean), stss = Buffer.alloc(4 * sync.length); sync.forEach((n, i) => stss.writeUInt32BE(n, 4 * i));
    const elst = Buffer.alloc(12 * el.length); el.forEach(([m, d], i) => { elst.writeUInt32BE(d, 12 * i); elst.writeInt32BE(m, 12 * i + 4); elst.writeUInt16BE(1, 12 * i + 8); elst.writeUInt16BE(0, 12 * i + 10); });
    const stbl = box("stbl", bk.stsd, full("stts", 0, 0, u32(1, samples.length, VF.DUR)), full("stss", 0, 0, u32(sync.length), stss), full("stsc", 0, 0, u32(1, 1, 1, 1)), full("stsz", 0, 0, u32(0, samples.length), sz), full("co64", 0, 0, u32(samples.length), co));
    const vtrak = box("trak", full("tkhd", 0, 3, u32(0, 0, 1, 0, dispDur), Buffer.alloc(8), Buffer.alloc(8), MATRIX, u32(VF.W << 16, VF.H << 16)), box("edts", full("elst", 0, 0, u32(el.length), elst)),
      box("mdia", full("mdhd", 0, 0, u32(0, 0, VF.TS, mediaDur), Buffer.from([0x55, 0xc4, 0, 0])), full("hdlr", 0, 0, u32(0), Buffer.from("vide"), Buffer.alloc(12), Buffer.from("slate lgfold\0")),
        box("minf", full("vmhd", 0, 1, Buffer.alloc(8)), box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))), stbl)));
    return box("moov", mvhd, vtrak, ...(audio ? [AVF.audioTrak(audio.ap.N, aRel.map((r) => hdr + r), aLens, dispDur)] : []));
  };
  const ftyp = box("ftyp", Buffer.from("isom"), u32(0x200), Buffer.from("isomiso2avc1mp41")), hdrLen = ftyp.length + moov(0).length + 16, mv = moov(hdrLen);
  const mdatH = Buffer.alloc(16); mdatH.writeUInt32BE(1); mdatH.write("mdat", 4, "latin1"); mdatH.writeBigUInt64BE(BigInt(16 + total), 8);
  const header = Buffer.concat([ftyp, mv, mdatH]), out = []; for (const p of pieces) out.push({ file: p.file, at: header.length + p.rel, off: p.off, len: p.len });
  for (let i = 0; i < aSrc.length; i++) out.push({ file: aSrc[i].file, at: header.length + aRel[i], off: aSrc[i].off, len: aSrc[i].len });
  return { size: header.length + total, header, pieces: out, frames: nfr, chunks: new Set(runs.filter((r) => !r.gap).map((r) => r.key)).size, hidden, runs: runs.length, edits: el.length, ...(audio ? { audio_runs: audio.ap.runs.length, audio_samples: audio.ap.N } : {}) };
}

/** make every chunk (picture, and sound if asked) the edit needs, in parallel, then assemble */
export async function lgfold(clips, total, { audio = false, workers = 6, onChunk = () => {} } = {}) {
  const t0 = Date.now(), pl = VF.plan(clips, total), ap = audio ? AVF.planAudio(clips, total) : null;
  const todo = [...[...pl.need.values()].filter((c) => !fs.existsSync(chunkPath(c.media, c.crop, c.k))).map((c) => () => makeChunk(c.src, c.media, c.crop, c.k)),
    ...(ap ? [...ap.need.values()].filter((c) => !fs.existsSync(AVF.audioChunkPath(c.media, c.k))).map((c) => () => AVF.makeAudioChunk(c.src, c.media, c.k)) : [])];
  const q = [...todo]; let made = 0; await Promise.all(Array.from({ length: workers }, async () => { while (q.length) { await q.shift()(); onChunk(++made, todo.length); } }));
  const files = new Map([...pl.need.entries()].map(([key, c]) => [key, chunkPath(c.media, c.crop, c.k)]));
  const v = assemble(pl, files, await blackChunk(), ap && { ap, files: new Map([...ap.need.entries()].map(([key, c]) => [key, AVF.audioChunkPath(c.media, c.k)])), silence: AVF.silenceChunk() }); v.ms = Date.now() - t0; v.made = made; return v;
}
