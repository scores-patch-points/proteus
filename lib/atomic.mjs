// atomic.mjs: the three primitives ingestion stands on.
//   writeAtomic   a file is either the old bytes or the new bytes, never half of each: write to a temp name, fsync, rename over the target.
//   acquireLock   one writer per content: an O_EXCL lock file naming its owner, taken over only when the owner is provably gone (dead pid on this host) or very old.
//   stepCache     a content-addressed cache for expensive deterministic work (a whisper run, a vision pass): key = hash of the inputs, value verified by its own hash on read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const rid = () => crypto.randomBytes(4).toString("hex");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
export const TMP_RE = /\.tmp\.\d+\.[0-9a-f]{8}$/;
export const tmpName = (file) => `${file}.tmp.${process.pid}.${rid()}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fsyncDir(dir) { try { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* not every filesystem allows it; the rename itself is still atomic */ } }

/** Write bytes so that a crash at any instant leaves the previous file intact. keepPrev: keep the last good copy beside it (file.prev) for repair. */
export function writeAtomic(file, data, { keepPrev = false, fsync = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === "string" ? data : JSON.stringify(data));
  const tmp = tmpName(file); let fd = null;
  try {
    fd = fs.openSync(tmp, "w", 0o644); let off = 0; while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    if (fsync) fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    if (keepPrev && fs.existsSync(file)) { try { fs.copyFileSync(file, file + ".prev"); } catch { /* a missing .prev only costs repair options */ } }
    fs.renameSync(tmp, file); if (fsync) fsyncDir(path.dirname(file));
  } catch (e) { if (fd != null) try { fs.closeSync(fd); } catch { /* already closed */ } try { fs.unlinkSync(tmp); } catch { /* nothing to remove */ } throw e; }
  return { bytes: buf.length, sha256: sha(buf) };
}
/** remove the temp files a crashed writer left behind (only ones whose writer pid is gone) */
export function cleanTmp(dir) {
  let n = 0; const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (TMP_RE.test(e.name)) { const pid = +/\.tmp\.(\d+)\./.exec(e.name)[1]; if (!alive(pid)) { try { fs.unlinkSync(p); n++; } catch { /* raced */ } } } } };
  walk(dir); return n;
}
export function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }

/** Take a lock file. Resolves {release} or {held:true, holder} after waitMs. A lock is taken over only if its owner is a dead process on THIS host, or it is older than staleMs. */
export async function acquireLock(file, { waitMs = 0, staleMs = 12 * 3600e3, note = "" } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); const token = rid() + rid(), end = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx"); fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), token, note })); fs.fsyncSync(fd); fs.closeSync(fd);
      return { release() { try { if (JSON.parse(fs.readFileSync(file, "utf8")).token === token) fs.unlinkSync(file); } catch { /* already gone or taken over */ } } };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let holder = null; try { holder = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* torn lock file */ }
      const age = (() => { try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return 0; } })();
      const gone = !holder ? age > 5000 : holder.host === os.hostname() ? !alive(holder.pid) : Date.now() - Date.parse(holder.at) > staleMs;
      if (gone || age > staleMs) { try { fs.unlinkSync(file); } catch { /* raced */ } continue; }
      if (Date.now() >= end) return { held: true, holder };
      await sleep(150);
    }
  }
}

/** Content-addressed cache for deterministic, expensive work. key: any JSON (hashed). Entries are verified by their recorded hash; a bad entry is ignored, never trusted. */
export function stepCache(dir = process.env.SLATE_INGEST_CACHE || path.join(os.homedir(), ".cache", "slate-ingest")) {
  const keyOf = (key) => sha(JSON.stringify(key)), pathOf = (k) => path.join(dir, k.slice(0, 2), k + ".json");
  return {
    dir, keyOf,
    get(key) { const p = pathOf(keyOf(key)); try { const e = JSON.parse(fs.readFileSync(p, "utf8")); if (e.sha256 !== sha(JSON.stringify(e.value))) { try { fs.unlinkSync(p); } catch { /* raced */ } return undefined; } return e.value; } catch { return undefined; } },
    put(key, value) { const body = JSON.stringify(value); try { writeAtomic(pathOf(keyOf(key)), JSON.stringify({ key: keyOf(key), at: new Date().toISOString(), sha256: sha(body), value }), { fsync: false }); return true; } catch { return false; } },
    async memo(key, produce) { const hit = this.get(key); if (hit !== undefined) return { value: hit, cached: true }; const value = await produce(); this.put(key, value); return { value, cached: false }; },
  };
}
