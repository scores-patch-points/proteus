// Proteus export: a recipe written out as a REAL file, verified against the ledger, recorded, never half-written, never silently different. Each test names how it could be false.
// Run: node --test test/export.test.mjs
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto"; import { spawnSync } from "node:child_process";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "export-test-")), CACHE = path.join(tmp, "chunks"); process.env.SLATE_VFOLD_CACHE = CACHE; process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const { loadLib, Pharos } = await import("../lib/door.mjs"); const VFL = await import("../lib/vfile.mjs"); const EX = await import("../lib/export.mjs"); const DF = await import("../lib/docfold.mjs"); const PF = await import("../lib/pfile.mjs"); const { essence } = await import("../lib/essence.mjs");
const ff = (...a) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a]); if (r.status !== 0) throw new Error("ffmpeg: " + r.stderr); };
fs.mkdirSync(path.join(tmp, "src"), { recursive: true }); fs.mkdirSync(path.join(tmp, "out"));
const A = path.join(tmp, "src", "a.mov"), B = path.join(tmp, "src", "b.mov");
ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=8", "-f", "lavfi", "-i", "sine=f=300:r=48000:d=8", "-c:v", "libx264", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", A);
ff("-f", "lavfi", "-i", "smptebars=s=640x360:r=24:d=8", "-f", "lavfi", "-i", "sine=f=700:r=48000:d=8", "-c:v", "libx264", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", B);
const [eA, eB] = [A, B].map((f) => essence(f, { persist: false })), clip = (s, e, i, m, p) => ({ s, e, in: i, media: m, path: p, crop: "" });
const v1 = () => [clip(0, 3, 0.5, eA, A), clip(3, 6, 1.0, eB, B)], v2 = () => [clip(0, 3, 0.5, eA, A), clip(3, 6, 2.5, eB, B)];
const lib = await loadLib(), ph = new Pharos({ dir: path.join(tmp, "ph"), lib }), by = "operator:tester", out = (n) => path.join(tmp, "out", n);
const rec = (clips, seq = "Main", o = {}) => VFL.record(ph, by, { project: "x", sequence: seq, clips, total: 6 }, { lg: true, audio: true, deep: true, ...o });
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"), body = (recipe) => ph.L.P.entries(ph.reader()).filter((e) => e.kind === "vfile" && e.addr === "vfile:x:Main" && e.body.recipe === recipe).at(-1).body;     // the genuine Main entry, not the doctored one made later
const r1 = await rec(v1()), r2 = await rec(v2());     // v2 retracts v1: v1 is an OLD version now

test("FALSE IF: the exported file is not the recorded file: sha256 equals the whole-file hash the ledger recorded, ffprobe reads it, and a vfile-export entry cites the recipe's vfile entry with the right path, size and hash", async () => {
  const x = await EX.exportRecipe(ph, by, { project: "x", sequence: "Main", to: out("final.mp4") });
  assert.equal(x.sha256, body(r2.recipe).file_sha256); assert.equal(sha(out("final.mp4")), x.sha256); assert.equal(x.verified, "file_sha256"); assert.equal(fs.statSync(out("final.mp4")).size, r2.size);
  const p = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", out("final.mp4")]).stdout); assert.deepEqual(p.streams.map((s) => s.codec_type).sort(), ["audio", "video"]);
  const e = ph.L.P.fold(ph.reader(), { kind: "vfile-export" }).entries.find((y) => y.id === x.id); assert.ok(e); assert.equal(e.cell, "REC·Figure"); assert.equal(e.body.path, out("final.mp4")); assert.equal(e.body.size, x.size); assert.equal(e.body.sha256, x.sha256);
  assert.deepEqual(e.of, [PF.live(ph, "x", "Main")[0].id], "it cites the live vfile entry");
});

test("FALSE IF: an OLD version cannot be brought back: the retracted first recipe exports, by its id prefix, to exactly the bytes it recorded, and they differ from the current version's", async () => {
  assert.notEqual(r1.recipe, r2.recipe); assert.equal(PF.live(ph, "x", "Main")[0].body.recipe, r2.recipe, "v1 is no longer live");
  const x = await EX.exportRecipe(ph, by, { recipe: r1.recipe.slice(0, 12), to: out("old.mp4") }); assert.equal(x.sha256, body(r1.recipe).file_sha256); assert.notEqual(x.sha256, body(r2.recipe).file_sha256);
});

test("FALSE IF: it overwrites, leaves debris, or half-writes: an existing file is refused without --force and untouched; --force replaces it whole; a folder target and a missing folder are refused; the out folder holds only intended files", async () => {
  fs.writeFileSync(out("precious.mp4"), "do not lose me");
  await assert.rejects(EX.exportRecipe(ph, by, { project: "x", sequence: "Main", to: out("precious.mp4") }), (e) => e.code === "exists"); assert.equal(fs.readFileSync(out("precious.mp4"), "utf8"), "do not lose me");
  const x = await EX.exportRecipe(ph, by, { project: "x", sequence: "Main", to: out("precious.mp4"), force: true }); assert.equal(sha(out("precious.mp4")), x.sha256);
  await assert.rejects(EX.exportRecipe(ph, by, { project: "x", sequence: "Main", to: path.join(tmp, "out") }), (e) => e.code === "exists");
  await assert.rejects(EX.exportRecipe(ph, by, { project: "x", sequence: "Main", to: path.join(tmp, "nope", "f.mp4") }), (e) => e.code === "no_dir");
  await assert.rejects(EX.exportRecipe(ph, by, { project: "x", sequence: "Main" }), (e) => e.code === "bad_args"); await assert.rejects(EX.exportRecipe(ph, by, { project: "x", sequence: "Nope", to: out("z.mp4") }), (e) => e.code === "no_recipe");
  assert.ok(!fs.readdirSync(path.join(tmp, "out")).some((f) => f.includes(".tmp")), "no temp files left");
});

test("FALSE IF: a failed export leaves a file or a ledger entry: a missing source, and a folder too small for the file, each refuse with their own code, write no file, and weave no vfile-export", async () => {
  const before = ph.L.P.fold(ph.reader(), { kind: "vfile-export" }).entries.length, files = fs.readdirSync(path.join(tmp, "out")).length;
  await assert.rejects(EX.exportRecipe(ph, by, { project: "x", sequence: "Main", to: out("space.mp4"), free: () => 1000 }), (e) => e.code === "no_space" && e.need > e.avail);
  const gone = path.join(tmp, "src", "gone.mov"); fs.copyFileSync(A, gone); const eG = essence(gone, { persist: false }); await VFL.record(ph, by, { project: "x", sequence: "Gone", clips: [clip(0, 2, 0, eG, gone)], total: 2 }, { lg: true, build: false }); fs.rmSync(gone);
  await assert.rejects(EX.exportRecipe(ph, by, { project: "x", sequence: "Gone", to: out("gone.mp4") }), (e) => e.code === "unavailable" && e.missing.includes(eG));
  assert.equal(ph.L.P.fold(ph.reader(), { kind: "vfile-export" }).entries.length, before); assert.equal(fs.readdirSync(path.join(tmp, "out")).length, files); assert.ok(!fs.existsSync(out("space.mp4")) && !fs.existsSync(out("gone.mp4")));
});

test("FALSE IF: a file the ledger would call different is written silently: a recipe whose recorded hash does not match the rebuild is refused (code differs), and only --allow-differs writes it, recorded as verified: differs", async () => {
  const b = PF.live(ph, "x", "Main")[0].body; ph.weave(by, "vfile", "vfile:x:Doctored", { ...b, sequence: "Doctored", header_sha256: "0".repeat(64), file_sha256: "1".repeat(64) }, []);
  await assert.rejects(EX.exportRecipe(ph, by, { project: "x", sequence: "Doctored", to: out("doctored.mp4") }), (e) => e.code === "differs"); assert.ok(!fs.existsSync(out("doctored.mp4")));
  const x = await EX.exportRecipe(ph, by, { project: "x", sequence: "Doctored", to: out("doctored.mp4"), allowDiffers: true }); assert.equal(x.verified, "differs"); assert.ok(fs.existsSync(out("doctored.mp4")));
});

test("FALSE IF: the listing lies about what is out there: it says present, changed (size, and a same-size edit only with --verify), missing, and STALE once a newer recipe replaces the exported one; and it never deletes anything", async () => {
  const x = await EX.exportRecipe(ph, by, { project: "x", sequence: "Main", to: out("tracked.mp4") }); const row = () => EX.listExports(ph, { recipe: x.recipe.slice(0, 16) }).find((r) => r.path === out("tracked.mp4")), rowV = () => EX.listExports(ph, { recipe: x.recipe.slice(0, 16), verify: true }).find((r) => r.path === out("tracked.mp4"));
  assert.equal(row().state, "present"); assert.equal(row().stale, false);
  const fd = fs.openSync(out("tracked.mp4"), "r+"); fs.writeSync(fd, Buffer.from([0xff]), 0, 1, 5000); fs.closeSync(fd); assert.equal(row().state, "present", "same size: only a hash can tell"); assert.equal(rowV().state, "changed");
  fs.appendFileSync(out("tracked.mp4"), "x"); assert.equal(row().state, "changed");
  await rec([clip(0, 3, 1.0, eA, A), clip(3, 6, 1.0, eB, B)]); assert.equal(row().stale, true, "a newer recipe now exists for x/Main"); assert.ok(row().current_recipe && row().current_recipe !== row().recipe);
  fs.rmSync(out("tracked.mp4")); assert.equal(row().state, "missing"); assert.ok(fs.existsSync(out("final.mp4")), "listing deleted nothing");
});

test("FALSE IF: the CLI is not wired: `proteus export` and `proteus exports` run from a shell against a pharos folder and print what the library returns", () => {
  const cli = (...a) => spawnSync("node", [path.join(import.meta.dirname, "..", "bin", "proteus.mjs"), ...a, "--pharos", ph.dir], { env: { ...process.env, SLATE_VFOLD_CACHE: CACHE } });
  const r = cli("export", "--recipe", r2.recipe.slice(0, 10), "--to", out("cli.mp4")); assert.equal(r.status, 0, r.stderr.toString()); const j = JSON.parse(r.stdout.toString()); assert.equal(j.sha256, body(r2.recipe).file_sha256); assert.equal(sha(out("cli.mp4")), j.sha256);
  const l = JSON.parse(cli("exports", "--project", "x").stdout.toString()); assert.ok(l.exports.some((e) => e.path === out("cli.mp4") && e.state === "present"));
  const bad = cli("export", "--recipe", r2.recipe.slice(0, 10), "--to", out("cli.mp4")); assert.equal(bad.status, 1); assert.match(bad.stderr.toString(), /exists/);
});

test("FALSE IF: documents are not exportable the same way: a Word document recipe exports to a .docx whose sha256 is the recorded one, the zip verifies, and the export is recorded", async () => {
  const { buildScenario, DOC } = await import("./doc-scenario.mjs"), S = await buildScenario(path.join(tmp, "docs")), dph = new Pharos({ dir: S.M3, lib: S.lib }), r = await DF.recordDoc(dph, by, { doc: DOC, owner: "alice" });
  const x = await EX.exportRecipe(dph, by, { project: DOC, sequence: "main", to: out("amendment.docx") }); assert.equal(x.format, "docx"); assert.equal(x.sha256, PF.live(dph, DOC, "main")[0].body.file_sha256); assert.equal(sha(out("amendment.docx")), x.sha256);
  assert.equal(spawnSync("unzip", ["-tq", out("amendment.docx")]).status, 0); assert.equal(EX.listExports(dph, { project: DOC })[0].state, "present"); void r;
});
