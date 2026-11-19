// serve.mjs: a virtual file by byte range over HTTP, from nothing but a recipe in the pharos.
//   GET  /v/<recipe or prefix>.mp4   the file (Range and HEAD supported). The first request builds it (header, plus any chunk not yet cached); later ones reuse it.
//   GET  /status                     the live recipes and their URLs
// A recipe names its inputs by essence id with a path hint; the hint is used when the file is there, and a missing source is a 424, never a guess.
// Bound to 127.0.0.1 unless told otherwise: it serves whatever the pharos says, so it is not for the open network.
import http from "node:http"; import fs from "node:fs";
import * as PF from "./pfile.mjs"; import * as VFL from "./vfile.mjs";

/** parse one Range header against a size. Returns {a,b} (inclusive), null (no range: send all), or "bad" (416). Multi-range is answered whole, as the spec allows. */
export function parseRange(h, size) {
  if (!h) return null; const m = /^bytes=(\d*)-(\d*)$/.exec(String(h).trim()); if (!m || (m[1] === "" && m[2] === "")) return h && /^bytes=/.test(h) && h.includes(",") ? null : "bad";
  let a, b; if (m[1] === "") { const n = +m[2]; if (!n) return "bad"; a = Math.max(0, size - n); b = size - 1; } else { a = +m[1]; b = m[2] === "" ? size - 1 : Math.min(+m[2], size - 1); }
  return a >= size || a > b ? "bad" : { a, b };
}

export function createServer(ph, { opts = {}, log = () => {} } = {}) {
  const built = new Map();      // recipe -> Promise<{ v, entry }>
  const liveAll = () => ph.L.P.fold(ph.reader(), { kind: "vfile" }).entries.filter((e) => e.body && e.body.recipe);
  const find = (id) => { const hits = liveAll().filter((e) => e.body.recipe.startsWith(id)); return hits.length === 1 ? hits[0] : hits.length ? "ambiguous" : null; };
  const get = (e) => {
    if (!built.has(e.body.recipe)) built.set(e.body.recipe, (async () => {
      if (!VFL.knownProjector(e.body.projector)) throw Object.assign(new Error(`recipe made by ${e.body.projector}; this build knows ${[VFL.PROJECTOR, VFL.AV_PROJECTOR, VFL.LG_PROJECTOR, VFL.LGAV_PROJECTOR].join(", ")}`), { status: 409 });
      const P = VFL.projectorFor(e.body.projector), { inputs, missing } = P.inputsFromBody(e.body, (id, hint) => hint);
      if (missing.length) throw Object.assign(new Error(`source not available: ${[...new Set(missing)].join(", ")}`), { status: 424 });
      const t0 = Date.now(), b = await P.build(inputs, opts); log(`built ${e.body.recipe.slice(0, 12)} ${b.size} bytes in ${Date.now() - t0} ms (${b.made} chunks made)`);
      return { v: b.v, e, stats: { size: b.size, ms: b.ms, made: b.made } };
    })().catch((err) => { built.delete(e.body.recipe); throw err; }));
    return built.get(e.body.recipe);
  };
  const send = (res, code, body, type = "text/plain") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
  const srv = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/status") return send(res, 200, JSON.stringify(liveAll().map((e) => ({ project: e.body.project, sequence: e.body.sequence, recipe: e.body.recipe, url: `/v/${e.body.recipe.slice(0, 16)}.mp4`, built: built.has(e.body.recipe) })), null, 2), "application/json");
      const m = /^\/v\/([0-9a-f]{6,64})\.mp4$/.exec(url.pathname); if (!m) return send(res, 404, "not found\n");
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "GET or HEAD\n");
      const hit = find(m[1]); if (!hit) return send(res, 404, "no live recipe with that id\n"); if (hit === "ambiguous") return send(res, 400, "that prefix matches more than one recipe\n");
      const { v } = await get(hit), size = v.size, rg = parseRange(req.headers.range, size);
      const h = { "content-type": "video/mp4", "accept-ranges": "bytes", etag: `"${hit.body.recipe}"`, "cache-control": "no-cache" };   // identity is the recipe, so the bytes never change under an etag
      if (rg === "bad") { res.writeHead(416, { ...h, "content-range": `bytes */${size}` }); return res.end(); }
      const a = rg ? rg.a : 0, b = rg ? rg.b : size - 1;
      res.writeHead(rg ? 206 : 200, { ...h, "content-length": b - a + 1, ...(rg ? { "content-range": `bytes ${a}-${b}/${size}` } : {}) });
      if (req.method === "HEAD") return res.end();
      let gone = false; res.on("close", () => (gone = true));
      for (const buf of VFL.VF.readRange(v, a, b)) { if (gone) return; if (!res.write(buf)) await new Promise((ok) => { const done = () => { res.off("drain", done); res.off("close", done); ok(); }; res.on("drain", done); res.on("close", done); }); }
      res.end();
    } catch (err) { if (!res.headersSent) send(res, err.status || 500, `${err.message}\n`); else res.destroy(); }
  });
  return srv;
}
