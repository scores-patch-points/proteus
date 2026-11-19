// vfold.mjs: the fold of an edit as a VIRTUAL mp4. No render per edit.
// Sources are mixed (AV1, H.264, VP9; many sizes and rates; long GOPs), so their own bytes cannot be cut frame-exactly. Once per 4 s of
// source that an edit touches, a chunk is made: 16:9 1280x720, 24 fps, every frame a keyframe, identical encoder settings (so every chunk
// shares one avcC). Chunks are cached by (essence, crop, index) and reused by every edit and every project that uses that footage.
// The fold is then a computed header (ftyp + moov whose sample table points at frames inside the chunks) followed by the chunks' mdat
// bytes, served by byte range. An edit changes only the ~12 bytes per frame of sample table: it costs milliseconds, plus any new chunks.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto"; import { spawn } from "node:child_process";
export const FPS = 24, CHUNK = 4, PER = CHUNK * FPS, TS = 12288, DUR = TS / FPS, W = 1280, H = 720, V = 2;   // v2: frames picked on an exact 24 fps grid in source time (-copyts + fps start_time); v1 drifted 1-2 frames on 23.976 sources
export const CACHE = process.env.SLATE_VFOLD_CACHE || path.join(os.homedir(), ".cache", "slate-timeline", "vfold");
const ENC = ["-c:v", "libx264", "-preset", "superfast", "-tune", "fastdecode", "-crf", "22", "-g", "1", "-bf", "0", "-x264-params", "keyint=1:scenecut=0",
  "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-video_track_timescale", String(TS), "-an"];
const run = (args) => new Promise((ok, no) => { const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] }); let e = ""; p.stderr.on("data", (d) => (e += d)); p.on("close", (c) => (c ? no(new Error(e.slice(-300))) : ok())); });
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---- minimal ISO-BMFF reading: the frames (offset, size) of a progressive mp4 and its raw stsd box
function boxes(buf, a, b) { const out = []; let p = a; while (p + 8 <= b) { let n = buf.readUInt32BE(p); const t = buf.toString("latin1", p + 4, p + 8); let h = 8; if (n === 1) { n = Number(buf.readBigUInt64BE(p + 8)); h = 16; } if (n === 0) n = b - p; out.push({ t, p, h, n }); p += n; } return out; }
const find = (buf, a, b, pathT) => { let r = { p: a - 8, h: 8, n: b - a + 8 }; for (const t of pathT) { r = boxes(buf, r.p + r.h, r.p + r.n).find((x) => x.t === t); if (!r) return null; } return r; };
const FRAMES = new Map();   // file -> parsed sample table (only the moov is read; chunks are immutable)
export function readFrames(file) {
  if (FRAMES.has(file)) return FRAMES.get(file);
  const fd = fs.openSync(file, "r"), size = fs.fstatSync(fd).size, hb = Buffer.alloc(16); let p = 0, moovB = null, mdat = null;
  try { while (p + 8 <= size) { fs.readSync(fd, hb, 0, 16, p); let n = hb.readUInt32BE(0), h = 8; const t = hb.toString("latin1", 4, 8); if (n === 1) { n = Number(hb.readBigUInt64BE(8)); h = 16; } if (n === 0) n = size - p;
      if (t === "moov") { moovB = Buffer.alloc(n); fs.readSync(fd, moovB, 0, n, p); } if (t === "mdat") mdat = { p, h, n }; p += n; } } finally { fs.closeSync(fd); }
  const r = parseMoov(file, moovB, mdat); FRAMES.set(file, r); return r;
}
function parseMoov(file, buf, mdatBox) {
  const moov = { p: 0, n: buf.length }, mdat = mdatBox;
  const st = (t) => find(buf, moov.p + 8, moov.p + moov.n, ["trak", "mdia", "minf", "stbl", t]);
  const stsz = st("stsz"), stco = st("stco") || st("co64"), stsc = st("stsc"), stsd = st("stsd");
  const fixed = buf.readUInt32BE(stsz.p + 12), n = buf.readUInt32BE(stsz.p + 16), sizes = []; for (let i = 0; i < n; i++) sizes.push(fixed || buf.readUInt32BE(stsz.p + 20 + 4 * i));
  const nc = buf.readUInt32BE(stco.p + 12), co = []; for (let i = 0; i < nc; i++) co.push(stco.t === "co64" ? Number(buf.readBigUInt64BE(stco.p + 16 + 8 * i)) : buf.readUInt32BE(stco.p + 16 + 4 * i));
  const ns = buf.readUInt32BE(stsc.p + 12), sc = []; for (let i = 0; i < ns; i++) sc.push([buf.readUInt32BE(stsc.p + 16 + 12 * i), buf.readUInt32BE(stsc.p + 20 + 12 * i)]);
  const offs = []; let s = 0; for (let c = 0; c < nc; c++) { const per = sc.filter((x) => x[0] <= c + 1).at(-1)[1]; let o = co[c]; for (let k = 0; k < per && s < n; k++, s++) { offs.push(o); o += sizes[s]; } }
  return { file, frames: offs.map((o, i) => [o, sizes[i]]), stsd: Buffer.from(buf.subarray(stsd.p, stsd.p + stsd.n)), mdat: [mdat.p + mdat.h, mdat.p + mdat.n] };
}

// ---- chunks
const cropKey = (crop) => (crop ? sha(crop).slice(0, 8) : "full");
export const chunkPath = (media, crop, k) => path.join(CACHE, `v${V}`, `${media}.${cropKey(crop)}`, `${k}.mp4`);
export async function makeChunk(src, media, crop, k) {
  const out = chunkPath(media, crop, k); if (fs.existsSync(out)) return out; fs.mkdirSync(path.dirname(out), { recursive: true }); const tmp = out + `.${process.pid}.tmp.mp4`;
  await run(["-y", "-loglevel", "error", "-copyts", "-ss", String(k * CHUNK), "-i", src, "-vf", `fps=${FPS}:start_time=${k * CHUNK},${crop}scale=${W}:${H}:flags=bicubic,setsar=1,format=yuv420p`, "-frames:v", String(PER), ...ENC, tmp]);
  fs.renameSync(tmp, out); return out;
}
export async function blackChunk() {
  const out = path.join(CACHE, `v${V}`, "black.mp4"); if (fs.existsSync(out)) return out; fs.mkdirSync(path.dirname(out), { recursive: true });
  await run(["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${FPS}`, "-frames:v", "2", "-vf", "setsar=1,format=yuv420p", ...ENC, out + ".tmp.mp4"]); fs.renameSync(out + ".tmp.mp4", out); return out;
}

// ---- the plan: edit frame -> (chunk, frame in chunk)
/** clips: [{s, e, in, src, media, path(abs), crop}] on one picture track. Returns frames [{key,k,j}] per edit frame and the chunk set needed. */
export function plan(clips, total) {
  const fr = [], need = new Map(); let cur = 0; const n = Math.round(total * FPS);
  for (const c of [...clips].sort((a, b) => a.s - b.s)) {
    const f0 = Math.round(c.s * FPS), f1 = Math.min(n, Math.round(c.e * FPS));
    for (; cur < f0 && cur < n; cur++) fr.push(null);
    for (let f = Math.max(cur, f0); f < f1; f++) {
      const t = +c.in + (f - f0) / FPS; let k = Math.floor(t / CHUNK + 1e-9), j = Math.round((t - k * CHUNK) * FPS); if (j >= PER) { k++; j -= PER; }
      const key = `${c.media}|${c.crop}|${k}`; if (!need.has(key)) need.set(key, { src: c.path, media: c.media, crop: c.crop, k }); fr.push({ key, k, j });
    }
    cur = Math.max(cur, f1);
  }
  for (; cur < n; cur++) fr.push(null);
  return { frames: fr, need };
}

// ---- writing the header
const box = (t, ...parts) => { const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(t, 4, "latin1"); return Buffer.concat([h, body]); };
const full = (t, v, f, ...parts) => { const h = Buffer.alloc(4); h.writeUInt32BE((v << 24) | f); return box(t, h, ...parts); };
const u32 = (...xs) => { const b = Buffer.alloc(4 * xs.length); xs.forEach((x, i) => b.writeUInt32BE(x >>> 0, 4 * i)); return b; };
const MATRIX = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
function moov(nfr, sizes, offs, stsd) {
  const dur = nfr * DUR, ms = Math.round((nfr / FPS) * 1000);
  const mvhd = full("mvhd", 0, 0, u32(0, 0, 1000, ms, 0x10000), Buffer.from([1, 0]), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(2));
  const tkhd = full("tkhd", 0, 3, u32(0, 0, 1, 0, ms), Buffer.alloc(8), Buffer.alloc(8), MATRIX, u32(W << 16, H << 16));
  const mdhd = full("mdhd", 0, 0, u32(0, 0, TS, dur), Buffer.from([0x55, 0xc4, 0, 0]));
  const hdlr = full("hdlr", 0, 0, u32(0), Buffer.from("vide"), Buffer.alloc(12), Buffer.from("slate vfold\0"));
  const co = Buffer.alloc(8 + 8 * offs.length); co.writeUInt32BE(offs.length, 4); offs.forEach((o, i) => co.writeBigUInt64BE(BigInt(o), 8 + 8 * i));
  const sz = Buffer.alloc(8 + 4 * sizes.length); sz.writeUInt32BE(sizes.length, 4); sizes.forEach((s, i) => sz.writeUInt32BE(s, 8 + 4 * i));
  const stbl = box("stbl", stsd, full("stts", 0, 0, u32(1, nfr, DUR)), full("stsc", 0, 0, u32(1, 1, 1, 1)), full("stsz", 0, 0, sz.subarray(0, 4), sz.subarray(4)), full("co64", 0, 0, co.subarray(4)));
  const minf = box("minf", full("vmhd", 0, 1, Buffer.alloc(8)), box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))), stbl);
  return box("moov", mvhd, box("trak", tkhd, box("mdia", mdhd, hdlr, minf)));
}
/** build the virtual file: { size, header, pieces:[{file, at, off, len}] } — bytes [at, at+len) of the file come from `file` at `off` */
export function assemble(pl, chunkFiles, black) {
  const info = new Map(); for (const [key, f] of chunkFiles) info.set(key, readFrames(f)); const bk = readFrames(black);
  const used = [...new Set(pl.frames.filter(Boolean).map((x) => x.key))]; const files = [bk, ...used.map((k) => info.get(k))];
  const ftyp = box("ftyp", Buffer.from("isom"), u32(0x200), Buffer.from("isomiso2avc1mp41"));
  // payload = each file's mdat body once, in order; a frame's offset = header + payload position of its file + (frame offset - mdat start)
  const base = new Map(); let pay = 0; for (const f of files) { base.set(f.file, pay); pay += f.mdat[1] - f.mdat[0]; }
  const sizes = [], rel = [];
  for (const x of pl.frames) { const F = x ? info.get(x.key) : bk; const j = x ? Math.min(x.j, F.frames.length - 1) : 0; const [o, s] = F.frames[j]; sizes.push(s); rel.push(base.get(F.file) + o - F.mdat[0]); }
  let mv = moov(pl.frames.length, sizes, rel.map(() => 0), bk.stsd); const mdatH = Buffer.alloc(16);
  const hdrLen = ftyp.length + mv.length + 16; mv = moov(pl.frames.length, sizes, rel.map((r) => hdrLen + r), bk.stsd);
  mdatH.writeUInt32BE(1); mdatH.write("mdat", 4, "latin1"); mdatH.writeBigUInt64BE(BigInt(16 + pay), 8);
  const header = Buffer.concat([ftyp, mv, mdatH]); const pieces = []; let at = header.length;
  for (const f of files) { const len = f.mdat[1] - f.mdat[0]; pieces.push({ file: f.file, at, off: f.mdat[0], len }); at += len; }
  return { size: at, header, pieces, frames: pl.frames.length, chunks: used.length };
}
/** read [a, b] (inclusive) of a virtual file into a stream-friendly list of Buffers */
export function* readRange(v, a, b) {
  if (a < v.header.length) yield v.header.subarray(a, Math.min(v.header.length, b + 1));
  for (const p of v.pieces) { const s = Math.max(a, p.at), e = Math.min(b + 1, p.at + p.len); if (s >= e) continue;
    const fd = fs.openSync(p.file, "r"); try { let pos = s; while (pos < e) { const n = Math.min(1 << 20, e - pos), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, p.off + (pos - p.at)); yield buf; pos += n; } } finally { fs.closeSync(fd); } }
}
/** make every chunk a plan needs (parallel), then assemble */
export async function vfold(pl, { workers = 6, onChunk = () => {} } = {}) {
  const t0 = Date.now(), todo = [...pl.need.entries()].filter(([, c]) => !fs.existsSync(chunkPath(c.media, c.crop, c.k))); let made = 0;
  const q = [...todo]; await Promise.all(Array.from({ length: workers }, async () => { while (q.length) { const [, c] = q.shift(); await makeChunk(c.src, c.media, c.crop, c.k); onChunk(++made, todo.length); } }));
  const files = new Map([...pl.need.entries()].map(([key, c]) => [key, chunkPath(c.media, c.crop, c.k)]));
  const v = assemble(pl, files, await blackChunk()); v.ms = Date.now() - t0; v.made = made; return v;
}
