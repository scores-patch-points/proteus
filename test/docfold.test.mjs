// Proteus folds a Word document: five writers, concurrent edits, a conflict, a move, a delete that others depend on, a revert. Each test names how the claim could be false.
// The oracles are written by hand from the scenario (test/doc-scenario.mjs), and the .docx is read by Python's zipfile+ElementTree, xmllint and macOS textutil, not by the code that wrote it.
// Run: node --test test/docfold.test.mjs
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doc-test-")); process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const { Pharos } = await import("../lib/door.mjs"); const DF = await import("../lib/docfold.mjs"); const PF = await import("../lib/pfile.mjs"); const { buildScenario, DOC, TEXT } = await import("./doc-scenario.mjs");
const S = await buildScenario(path.join(root, "log")), by = "proteus";
const pharos = (dir) => new Pharos({ dir, lib: S.lib });
const main = pharos(S.M3), strip = (s) => s.replaceAll("**", "");

// ---- an independent reader of the .docx: accept-all text, reject-all text, tracked-change authors, comments
const PY = `
import sys, zipfile, json, xml.etree.ElementTree as ET
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip(); d=ET.fromstring(z.read('word/document.xml')); c=ET.fromstring(z.read('word/comments.xml'))
def walk(el, i, dl, out):
    for ch in el:
        t=ch.tag
        if t==W+'ins': walk(ch, True, dl, out)
        elif t==W+'del': walk(ch, i, True, out)
        elif t==W+'t': out.append((ch.text or '', i, dl, 't'))
        elif t==W+'delText': out.append((ch.text or '', i, dl, 'd'))
        else: walk(ch, i, dl, out)
res={'zip_ok': bad is None, 'accept':[], 'reject':[], 'marks_ins':[], 'marks_del':[], 'ins_authors':[], 'del_authors':[], 'comments':[], 'styles':[]}
for p in d.iter(W+'p'):
    ppr=p.find(W+'pPr'); mi=md=None; st=None
    if ppr is not None:
        s=ppr.find(W+'pStyle'); st=s.get(W+'val') if s is not None else None
        r=ppr.find(W+'rPr')
        if r is not None:
            a=r.find(W+'ins'); b=r.find(W+'del')
            if a is not None: mi=a.get(W+'author')
            if b is not None: md=b.get(W+'author')
    runs=[]; walk(p, False, False, runs)
    acc=''.join(t for t,i,dl,k in runs if k=='t' and not dl); rej=''.join(t for t,i,dl,k in runs if k=='d' or (k=='t' and not i))
    if md is None: res['accept'].append(acc); res['styles'].append(st)
    if mi is None: res['reject'].append(rej)
    if mi is not None: res['marks_ins'].append([mi, acc])
    if md is not None: res['marks_del'].append([md, rej])
for e in d.iter(W+'ins'): res['ins_authors'].append(e.get(W+'author'))
for e in d.iter(W+'del'): res['del_authors'].append(e.get(W+'author'))
for e in c.iter(W+'comment'): res['comments'].append([e.get(W+'author'), ''.join(t.text or '' for t in e.iter(W+'t'))])
print(json.dumps(res))`;
const read = (bytes, name) => { const f = path.join(root, name + ".docx"); fs.writeFileSync(f, bytes); const r = spawnSync("python3", ["-I", "-c", PY, f]); assert.equal(r.status, 0, r.stderr.toString()); return { ...JSON.parse(r.stdout.toString()), file: f }; };

const mainRec = await DF.recordDoc(main, by, { doc: DOC, owner: "alice" }); const mainDoc = read((await DF.openDoc(main, DOC)).v.bytes, "main");
const ACCEPT = ["b1", "b2*", "b3", "b4*", "b5", "b11*", "b7", "b8", "b6", "b9"];
const OR = { "b2*": "This Amendment is entered into as of **April 1, 2026** between Northwind Traders and Contoso Ltd.", "b4*": "The term shall continue for thirty (30) months from the Effective Date.", "b11*": "Disputed invoices must be raised within fifteen (15) days of receipt." };
const t = (k) => strip(OR[k] || TEXT[k.replace("*", "")]);

test("FALSE IF: the merged document is wrong: with 5 writers, concurrent inserts after one paragraph, a move, a delete, a resolved conflict and a revert, the accept-all text is exactly the hand-derived document, in order", () => {
  const want = [t("b1"), t("b2*"), t("b3"), t("b4*"), t("b5"), t("b11*"), t("b7"), t("b8"), t("b6"), t("b9")];
  assert.deepEqual(mainDoc.accept, want);
  assert.equal(mainRec.conflicts.length, 0, "the §1 conflict was resolved by erin's edit citing both sides");
  assert.deepEqual(mainDoc.styles, ["Heading1", "Normal", "Heading2", "Normal", "Heading2", "Normal", "Heading2", "Normal", "Normal", "Heading2"]);
});

test("FALSE IF: authorship is lost or wrong: tracked insertions name carol (her clause) and dana (the moved paragraph), tracked deletions name dana (the old place of the move) and erin (bob's deleted clause), and the comment is erin's", () => {
  assert.deepEqual(mainDoc.marks_ins, [["carol", t("b11*")], ["dana", t("b6")]]);
  assert.deepEqual(mainDoc.marks_del, [["dana", t("b6")], ["erin", strip("Late payments accrue interest at 1.5% per month.")]]);
  assert.deepEqual(mainDoc.comments, [["erin", "Legal: is a 2x cap acceptable to Contoso?"]]);
  for (const a of ["erin", "carol"]) assert.ok(mainDoc.ins_authors.includes(a) && mainDoc.del_authors.includes(a), `${a} has tracked word-level changes`);
});

test("FALSE IF: reject-all does not give the previous state: it must bring back the two deleted paragraphs, drop the two inserted ones, and show each edited paragraph as it was before its last change", () => {
  const rej = mainDoc.reject; assert.equal(rej.length, 10);
  assert.equal(rej[1], strip("This Amendment is entered into as of **April 1** between Northwind and Contoso."), "before erin's edit: dana's text");
  assert.ok([strip("The term shall continue for thirty-six (36) months from the Effective Date."), strip("The term shall continue for eighteen (18) months from the Effective Date.")].includes(rej[3]), "before the resolution: one side of the conflict");
  assert.equal(rej[5], t("b6")); assert.equal(rej[6], "Late payments accrue interest at 1.5% per month.", "bob's clause as it was when erin deleted it, not bob's later edit");
  assert.equal(rej[8], "Each party's liability is capped at two times the fees paid in the prior twelve months.", "before carol's revert");
  assert.ok(!rej.includes(t("b11*")), "an inserted paragraph is absent when rejected");
});

test("FALSE IF: bob's edit to a clause erin deleted leaks into the document, or is lost from the log: it is not shown, and is counted as an orphan the fold knew about", async () => {
  const snap = DF.snapshot(main, DOC), entries = new Map(main.L.P.entries(main.reader()).map((e) => [e.id, e])), model = DF.modelFrom({ doc: DOC, owner: "alice", entries, live: snap.live, dead: snap.dead });
  assert.ok(!JSON.stringify(mainDoc).includes("2% per month"), "bob's later edit is not in the document"); assert.equal(model.orphans, 1);
  assert.ok(snap.live.includes(S.ref.T7), "it is still live in the log: nothing was erased, only not shown");
});

test("FALSE IF: a conflict is silent: before erin's resolution the pharos reports bob and dana as concurrent on §1, the document shows one side and keeps the other as a comment by its author", async () => {
  const m2 = path.join(root, "M2copy"); fs.cpSync(S.M2, m2, { recursive: true }); const ph = pharos(m2), r = await DF.recordDoc(ph, by, { doc: DOC, owner: "alice", branch: "round2" });
  assert.equal(r.conflicts.length, 1); assert.equal(r.conflicts[0].addr, `text:${DOC}:b4`); assert.deepEqual([...r.conflicts[0].by].sort(), ["bob", "dana"]);
  const d = read((await DF.openDoc(ph, DOC, "round2")).v.bytes, "round2"), c = d.comments.filter(([, x]) => x.startsWith("Concurrent edit, not applied"));
  assert.equal(c.length, 1); const loser = c[0][0]; assert.ok(["bob", "dana"].includes(loser)); const winnerText = d.accept[3];
  assert.ok(winnerText.includes(loser === "bob" ? "eighteen (18)" : "thirty-six (36)"), "the shown text is the OTHER side");
  assert.ok(c[0][1].includes(loser === "bob" ? "thirty-six (36)" : "eighteen (18)"), "the comment carries the loser's text");
  // order at this point, derived by hand: children of the tombstoned fees paragraph sort newest first (bob lc 11, carol lc 10, then alice's liability heading), the moved copy follows liability's text
  assert.deepEqual(d.accept.length, 11); assert.equal(d.accept[5], "Late payments accrue interest at 1.5% per month."); assert.equal(d.accept[6], t("b11*")); assert.equal(d.accept[7], t("b7"));
});

test("FALSE IF: WITHOUT a writer is not exact: without dana, her edits AND everything built on them go (erin's two edits cite hers), the moved paragraph returns to its place, and bob's side of the old conflict stands", async () => {
  const r = await DF.recordDoc(main, by, { doc: DOC, owner: "alice", branch: "without-dana", exclude: ["dana"] }), d = read((await DF.openDoc(main, DOC, "without-dana")).v.bytes, "no-dana");
  assert.deepEqual(d.accept, [t("b1"), TEXT.b2.replaceAll("**", ""), t("b3"), "The term shall continue for thirty-six (36) months from the Effective Date.", t("b5"), t("b6"), t("b11*"), t("b7"), t("b8"), t("b9")]);
  assert.equal(r.conflicts.length, 0); assert.ok(!d.ins_authors.includes("dana") && !d.del_authors.includes("dana"), "dana appears nowhere");
});

test("FALSE IF: WITHOUT a writer does not restore what they removed: without erin, bob's late-payment clause is back WITH bob's later edit, the §1 conflict is open again, and her comment is gone", async () => {
  const r = await DF.recordDoc(main, by, { doc: DOC, owner: "alice", branch: "without-erin", exclude: ["erin"] }), d = read((await DF.openDoc(main, DOC, "without-erin")).v.bytes, "no-erin");
  assert.equal(d.accept[5], "Late payments accrue interest at 2% per month."); assert.equal(d.accept.length, 11); assert.equal(d.comments.filter(([a]) => a === "erin").length, 0);
  assert.equal(r.conflicts.length, 1); assert.deepEqual([...r.conflicts[0].by].sort(), ["bob", "dana"]); assert.ok(d.comments.some(([, x]) => x.startsWith("Concurrent edit, not applied")));
});

test("FALSE IF: AS OF is not a causal past: as of bob's first edit, the document is the base plus that one edit and nothing from the other writers", async () => {
  await DF.recordDoc(main, by, { doc: DOC, owner: "alice", branch: "as-of-bob-T1", asof: S.ref.T1 }); const d = read((await DF.openDoc(main, DOC, "as-of-bob-T1")).v.bytes, "asof");
  assert.deepEqual(d.accept, ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9"].map((k) => k === "b4" ? "The term shall continue for thirty-six (36) months from the Effective Date." : strip(TEXT[k])));
  assert.deepEqual(d.marks_ins, [["bob", "The term shall continue for thirty-six (36) months from the Effective Date."].slice(0, 0)].flat(), "no inserted or deleted paragraphs yet");
});

test("FALSE IF: variants disturb the main log or each other: the main recipe is unchanged by recording four branches, no whatif retraction exists in it, and each branch is its own live recipe", () => {
  const live = PF.live; const addrs = main.L.P.fold(main.reader(), { kind: "vfile" }).entries.map((e) => e.addr).sort();
  assert.deepEqual(addrs, [`vfile:${DOC}:as-of-bob-T1`, `vfile:${DOC}:main`, `vfile:${DOC}:without-dana`, `vfile:${DOC}:without-erin`].sort());
  assert.equal(live(main, DOC, "main").length, 1); assert.equal(live(main, DOC, "main")[0].body.recipe, mainRec.recipe);
  assert.ok(!main.L.P.entries(main.reader()).some((e) => e.by === "whatif"), "variants were made in scratch copies");
});

test("FALSE IF: it is not reproducible: rebuilt from the recipe alone by a fresh connection the bytes are identical, check says identical, and an unrelated entry in the log does not change the recipe", async () => {
  const fresh = pharos(S.M3), r = await DF.checkDoc(fresh, by, DOC, "main"); assert.equal(r.status, "identical", JSON.stringify({ e: r.expected, f: r.found }));
  assert.equal(PF.live(fresh, DOC, "main")[0].body.header_sha256, mainRec.header_sha256, "same bytes as when recorded");
  const other = S.lib.P.open("doc", { dir: S.M3, writer: "frank" }); S.lib.P.weave(other, { cell: "INS·Figure", kind: "doc-block", addr: "block:other:x", body: { doc: "other", id: "x", after: null, style: "p", text: "unrelated", lc: 1 }, of: [], basis: {} });
  const again = await DF.recordDoc(pharos(S.M3), by, { doc: DOC, owner: "alice" }); assert.equal(again.unchanged, true, "another document's entry does not touch this recipe");
});

test("FALSE IF: a recipe pretends its inputs are there: with one writer's file missing, a check says unavailable and names the missing entries, never a wrong document", async () => {
  const gone = path.join(root, "gone"); fs.cpSync(S.M3, gone, { recursive: true }); fs.rmSync(path.join(gone, "bob.phr")); const r = await DF.checkDoc(pharos(gone), by, DOC, "main");
  assert.equal(r.status, "unavailable"); assert.ok(r.missing.length >= 2 && r.missing.includes(S.ref.T7), `missing ${r.missing.length}`);
});

test("FALSE IF: the file is not a real Word file: every part is well-formed XML (xmllint), the zip verifies, and macOS's own text reader opens it and sees the final text", () => {
  const f = mainDoc.file; assert.equal(mainDoc.zip_ok, true);
  for (const part of ["\\[Content_Types\\].xml", "_rels/.rels", "docProps/core.xml", "word/document.xml", "word/styles.xml", "word/comments.xml", "word/_rels/document.xml.rels"]) {
    const x = spawnSync("unzip", ["-p", f, part]); assert.equal(x.status, 0); const l = spawnSync("xmllint", ["--noout", "-"], { input: x.stdout }); assert.equal(l.status, 0, `${part}: ${l.stderr}`); }
  const tx = spawnSync("textutil", ["-convert", "txt", "-stdout", f]); assert.equal(tx.status, 0, tx.stderr.toString()); const text = tx.stdout.toString();
  assert.ok(text.includes("thirty (30) months") && text.includes("Disputed invoices") && text.includes("4. Signatures"), "textutil read the document");
  console.log(`# textutil reads ${text.split("\n").filter(Boolean).length} non-empty lines; docx ${fs.statSync(f).size} bytes; log ${S.entriesIn(S.M3)} entries by 5 writers`);
});
