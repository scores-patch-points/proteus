// Proteus honouring EODB's management entries. Needs ffmpeg. Run: node --test test/manage.test.mjs
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proteus-manage-")), CACHE = path.join(tmp, "chunks"); process.env.SLATE_VFOLD_CACHE = CACHE;
const { loadLib, Pharos } = await import("../lib/door.mjs"); const VFL = await import("../lib/vfile.mjs"); const MG = await import("../lib/manage.mjs"); const { essence } = await import("../lib/essence.mjs");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const ff = (...a) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a]); if (r.status !== 0) throw new Error("ffmpeg: " + r.stderr); };
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
const A = path.join(tmp, "src", "a.mp4"), B = path.join(tmp, "src", "b.mp4");
ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=6", "-c:v", "libx264", "-g", "48", "-pix_fmt", "yuv420p", A);
ff("-f", "lavfi", "-i", "smptebars=s=640x360:r=24:d=6", "-c:v", "libx264", "-g", "48", "-pix_fmt", "yuv420p", B);
const eA = essence(A, { persist: false }), eB = essence(B, { persist: false }), resolver = (m) => ({ [eA]: A, [eB]: B })[m] || null;
const X = () => [{ s: 0, e: 3, in: 0, media: eA, path: A, crop: "" }, { s: 3, e: 6, in: 1, media: eB, path: B, crop: "" }];   // chunks: a0, b0
const Y = () => [{ s: 0, e: 3, in: 0, media: eA, path: A, crop: "" }];                                                          // chunks: a0 (shared with X)
const by = "proteus"; let n = 0;
const chunk = (m) => VF_path(m);
const VF_path = (m) => VFL.VF.chunkPath(m, "", 0);
const fresh = async () => new Pharos({ dir: path.join(tmp, `ph${++n}`), lib: await loadLib() });

// what EODB does, as another writer: declare its kinds and weave its decisions. Proteus only reads them.
function eodb(ph) {
  const w = ph.L.P.open(ph.name, { dir: ph.dir, writer: "eodb" }), g = ph.L.P.ground(w);
  for (const [k, c] of [["vfile-pin", "DEF·Figure"], ["vfile-evict", "SEG·Figure"]]) if (!g.kinds.some((x) => x.name === k)) ph.L.P.weave(w, { cell: "DEF·Figure", kind: "kind", addr: `kind:${k}`, body: { name: k, cell: c }, basis: {} });
  const weave = (cell, kind, recipe, of) => ph.L.P.weave(w, { cell, kind, addr: `${kind}:${recipe.slice(0, 16)}`, body: { recipe, why: "test", nonce: Math.random() }, of, basis: {} });
  return { pin: (r) => weave("DEF·Figure", "vfile-pin", r.recipe, [r.id]), evict: (r) => weave("SEG·Figure", "vfile-evict", r.recipe, r.id ? [r.id] : []), unpin: (e) => ph.L.P.weave(w, { cell: "NUL·Figure", kind: "retract", addr: `retract:${e.id.slice(0, 12)}`, body: { why: "unpin" }, of: [e.id], basis: {} }) };
}
async function two(ph) {
  const rx = await VFL.record(ph, by, { project: "p", sequence: "X", clips: X(), total: 6 }), ry = await VFL.record(ph, by, { project: "p", sequence: "Y", clips: Y(), total: 3 });
  return { rx, ry };
}

test("what a recipe needs is recomputed from its own clips: X needs the a and b chunks, Y only a's", async () => {
  const ph = await fresh(), { rx, ry } = await two(ph);
  assert.deepEqual(MG.chunkPaths(ph.entry(rx.id).body).sort(), [chunk(eA), chunk(eB)].sort()); assert.deepEqual(MG.chunkPaths(ph.entry(ry.id).body), [chunk(eA)]);
  assert.ok(fs.existsSync(chunk(eA)) && fs.existsSync(chunk(eB)), "built, so cached");
});

test("evicting X drops only the chunk nothing else needs: a's chunk is shared with the live file Y and stays", async () => {
  const ph = await fresh(), { rx } = await two(ph), E = eodb(ph), req = E.evict({ id: rx.id, recipe: rx.recipe });
  const dry = MG.sweep(ph, by, { dry: true }); assert.equal(dry.results[0].chunks_removed, 1); assert.ok(fs.existsSync(chunk(eB)), "a dry run deletes nothing"); assert.equal(ph.fold({ kind: "vfile-evicted" }).matched, 0, "and weaves nothing");
  const r = MG.sweep(ph, by); assert.equal(r.answered, 1); const a = r.results[0];
  assert.equal(a.result, "dropped"); assert.equal(a.chunks_removed, 1); assert.equal(a.shared_kept, 1); assert.ok(a.bytes > 0);
  assert.ok(!fs.existsSync(chunk(eB)), "b's chunk is gone"); assert.ok(fs.existsSync(chunk(eA)), "a's chunk stays: Y still needs it");
  const ack = ph.entry(a.id); assert.equal(ack.kind, "vfile-evicted"); assert.equal(ack.cell, "REC·Figure"); assert.deepEqual(ack.of, [req.id]); assert.equal(ack.body.evict, req.id);
  assert.equal(MG.sweep(ph, by).answered, 0, "each request is answered once");
  assert.equal(ph.fold({ kind: "vfile" }).matched, 2, "the recipes are still in the ledger: only cache bytes were dropped");
});

test("a pinned file is never dropped, and a pin protects chunks a requested file shares; unpinning makes the request honourable", async () => {
  const ph = await fresh(), { rx, ry } = await two(ph), E = eodb(ph), pin = E.pin({ id: ry.id, recipe: ry.recipe });
  E.evict({ id: rx.id, recipe: rx.recipe }); E.evict({ id: ry.id, recipe: ry.recipe });
  const r = MG.sweep(ph, by), by_recipe = Object.fromEntries(r.results.map((x) => [x.recipe, x]));
  assert.equal(by_recipe[ry.recipe].result, "refused_pinned"); assert.equal(by_recipe[ry.recipe].chunks_removed, 0);
  assert.equal(by_recipe[rx.recipe].chunks_removed, 1, "only b: a is protected by the pinned Y"); assert.equal(by_recipe[rx.recipe].shared_kept, 1);
  assert.ok(fs.existsSync(chunk(eA)), "the pinned file's bytes are intact");
  E.unpin(pin); E.evict({ id: ry.id, recipe: ry.recipe });                                                                 // a new request after unpinning
  const r2 = MG.sweep(ph, by); assert.equal(r2.results.at(-1).result, "dropped"); assert.ok(!fs.existsSync(chunk(eA)), "now a's chunk goes: nothing live needs it");
});

test("eviction is a cache drop: after it, the recipe rebuilds the same bytes from the media alone", async () => {
  const ph = await fresh(), q = { project: "p", sequence: "X" }, rx = await VFL.record(ph, by, { ...q, clips: X(), total: 6 }, { deep: true });
  eodb(ph).evict({ id: rx.id, recipe: rx.recipe }); const r = MG.sweep(ph, by); assert.equal(r.results[0].chunks_removed, 2);
  assert.ok(!fs.existsSync(chunk(eA)) && !fs.existsSync(chunk(eB)));
  const c = await VFL.check(ph, by, q, { resolve: resolver, deep: true });
  assert.equal(c.status, "identical", "same size, header and file bytes"); assert.ok(c.made >= 2, "the chunks were encoded again");
});

test("a request for a recipe that is not in the ledger is answered as such, not guessed", async () => {
  const ph = await fresh(), E = eodb(ph); E.evict({ id: null, recipe: "e".repeat(64) });
  const r = MG.sweep(ph, by); assert.equal(r.results[0].result, "no_such_file");
});

test("Proteus reads EODB's kinds by kind and imports nothing of EODB", () => {
  const src = fs.readFileSync(new URL("../lib/manage.mjs", import.meta.url), "utf8");
  const imports = [...src.matchAll(/ from "([^"]+)"/g)].map((m) => m[1]);        // every import on every line: Node's own modules, or a file in this repo's lib/ ; never another repo
  assert.ok(imports.length >= 2 && imports.every((i) => i.startsWith("node:") || /^\.\/[a-z]+\.mjs$/.test(i)), imports.join(", ")); assert.ok(!imports.some((i) => /eodb|slate|pharos/i.test(i)), "nothing of EODB, Slate or the pharos is imported here");
});
