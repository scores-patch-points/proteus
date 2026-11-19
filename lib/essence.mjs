// Essence identity for raw media: a hash of the decoded-container packets (ffmpeg streamhash, sha256 per stream), not of the file.
// Same essence = same media, whatever the file is called, wherever it lives, and after a remux or a metadata edit.
// Measured: 0.35 s for a 30 MB 720p mp4 (M3); results cached by (realpath, size, mtime, inode) so a file is hashed once.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process";
const CACHE = path.join(os.homedir(), ".cache", "slate-timeline", "essence.json");
const MEDIA = /\.(mp4|mov|m4v|mkv|webm|mxf|avi|mts|wav|aif|aiff|mp3|m4a|flac|aac)$/i;
// the cache is a convenience, never a source of truth: a torn or unreadable file is ignored, and writes are atomic (two ingests at once must not corrupt it)
import { writeAtomic } from "./atomic.mjs";
let C = null; const load = () => { if (C) return C; try { C = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {}; } catch { C = {}; } return C; };
const save = () => { try { writeAtomic(CACHE, JSON.stringify(C), { fsync: false }); } catch { /* an unwritable cache only costs time */ } };
/** "ess_" + 32 hex of sha256 over the per-stream packet hashes */
export function essence(file, { persist = true } = {}) {
  const real = fs.realpathSync(file), st = fs.statSync(real), key = `${real}|${st.size}|${st.mtimeMs}|${st.ino}`, c = load();
  if (c[key]) return c[key];
  const lines = execFileSync("ffmpeg", ["-loglevel", "error", "-i", real, "-map", "0", "-c", "copy", "-f", "streamhash", "-hash", "sha256", "-"], { encoding: "utf8", maxBuffer: 1 << 20 }).trim();
  const id = "ess_" + crypto.createHash("sha256").update(lines).digest("hex").slice(0, 32); c[key] = id; if (persist) save(); return id;
}
/** walk roots, essence every media file: Map(ess -> [paths]) */
export function indexRoots(roots, { onFile = () => {} } = {}) {
  const m = new Map(), seen = new Set();
  const walk = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { if (e.name.startsWith(".")) continue; const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (MEDIA.test(e.name)) { let r; try { r = fs.realpathSync(p); } catch { continue; } if (seen.has(r)) continue; seen.add(r);
        try { const id = essence(r, { persist: false }); (m.get(id) || m.set(id, []).get(id)).push(r); onFile(r, id); } catch {} } } };
  for (const r of roots) walk(path.resolve(r)); save(); return m;
}
