// A scripted multi-writer history of one Word document ("Amendment 3"), for test/docfold.test.mjs and for making demo files. Five writers, each working in their OWN copy of the log
// (so their edits are really concurrent, not interleaved), merged by the pharos's own rule: a union of the writers' files. Nothing here is Proteus: it is what editors would write.
//
//   base      alice writes 9 blocks.
//   round 2   (all from the base, concurrently)
//             bob   edits §1 to 36 months                         | inserts a late-payment clause after the fees paragraph
//             carol inserts a disputed-invoices clause after the SAME fees paragraph | edits the liability cap to "two times"
//             dana  edits §1 to 18 months (CONFLICT with bob)      | edits the date                       | MOVES the fees paragraph below liability
//             erin  comments on the liability paragraph
//   merge     -> M2
//   round 3   (from M2, concurrently)
//             erin  resolves the §1 conflict (cites BOTH sides)    | edits the date again, building on dana's edit (a dependency) | DELETES bob's late-payment clause
//             bob   edits his late-payment clause (has not seen the delete)
//             carol reverts her liability edit
//   merge     -> M3
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import { loadLib } from "../lib/door.mjs";

export const DOC = "msa3", WRITERS = ["alice", "bob", "carol", "dana", "erin"];
export const TEXT = {
  b1: "Amendment 3 to the Master Services Agreement",
  b2: "This Amendment is entered into as of **March 1** between Northwind and Contoso.",
  b3: "1. Term", b4: "The term shall continue for twenty-four (24) months from the Effective Date.",
  b5: "2. Fees", b6: "Fees are payable net thirty (30) days from invoice.",
  b7: "3. Liability", b8: "Each party's liability is capped at the fees paid in the prior twelve months.",
  b9: "4. Signatures",
};

export async function buildScenario(root) {
  const lib = await loadLib(), P = lib.P, ref = { b: {} }, dirOf = (n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); return d; };
  const lcOf = (dir) => 1 + Math.max(0, ...P.entries(P.open("doc", { dir, writer: "reader", frame: false })).filter((e) => e.kind.startsWith("doc-")).map((e) => e.body.lc));
  const writer = (dir, who) => {
    const h = P.open("doc", { dir, writer: who });
    return {
      block: (id, after, style, text, of = []) => P.weave(h, { cell: "INS·Figure", kind: "doc-block", addr: `block:${DOC}:${id}`, body: { doc: DOC, id, after, style, text, lc: lcOf(dir) }, of, basis: {} }).id,
      text: (block, text, of) => P.weave(h, { cell: "REC·Figure", kind: "doc-text", addr: `text:${DOC}:${block}`, body: { doc: DOC, block, text, lc: lcOf(dir) }, of, basis: {} }).id,
      note: (block, text, of) => P.weave(h, { cell: "EVA·Figure", kind: "doc-note", addr: `note:${DOC}:${block}:${who}`, body: { doc: DOC, block, text, lc: lcOf(dir) }, of, basis: {} }).id,
      retract: (ids, why) => P.weave(h, { cell: "NUL·Figure", kind: "retract", addr: `retract:${crypto.createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 16)}`, body: { why }, of: ids, basis: {} }).id,
      declare: () => { for (const [name, cell] of [["doc-block", "INS·Figure"], ["doc-text", "REC·Figure"], ["doc-note", "EVA·Figure"]]) P.weave(h, { cell: "DEF·Figure", kind: "kind", addr: `kind:${name}`, body: { name, cell }, basis: {} }); },
    };
  };
  const copy = (from, to) => fs.cpSync(from, to, { recursive: true });
  const union = (to, parts) => { fs.mkdirSync(to, { recursive: true }); for (const [who, dir] of Object.entries(parts)) fs.copyFileSync(path.join(dir, `${who}.phr`), path.join(to, `${who}.phr`)); };   // one file per writer: merge is a union of files

  // ---- base
  const base = dirOf("base"), A = writer(base, "alice"); A.declare();
  const spec = [["b1", null, "h1"], ["b2", "b1", "p"], ["b3", "b2", "h2"], ["b4", "b3", "p"], ["b5", "b4", "h2"], ["b6", "b5", "p"], ["b7", "b6", "h2"], ["b8", "b7", "p"], ["b9", "b8", "h2"]];
  for (const [id, after, style] of spec) ref.b[id] = A.block(id, after, style, TEXT[id], after ? [ref.b[after]] : []);
  const rep = Object.fromEntries(["bob", "carol", "dana", "erin"].map((w) => [w, dirOf("r2-" + w)])); for (const d of Object.values(rep)) copy(base, d);

  // ---- round 2 (concurrent)
  const B = writer(rep.bob, "bob"), C = writer(rep.carol, "carol"), D = writer(rep.dana, "dana"), E = writer(rep.erin, "erin");
  ref.T1 = B.text("b4", "The term shall continue for thirty-six (36) months from the Effective Date.", [ref.b.b4]);
  ref.b10 = B.block("b10", "b6", "p", "Late payments accrue interest at 1.5% per month.", [ref.b.b6]);
  ref.b11 = C.block("b11", "b6", "p", "Disputed invoices must be raised within fifteen (15) days of receipt.", [ref.b.b6]);
  ref.T2 = C.text("b8", "Each party's liability is capped at **two times** the fees paid in the prior twelve months.", [ref.b.b8]);
  ref.T3 = D.text("b4", "The term shall continue for eighteen (18) months from the Effective Date.", [ref.b.b4]);
  ref.T4 = D.text("b2", "This Amendment is entered into as of **April 1** between Northwind and Contoso.", [ref.b.b2]);
  ref.b6m = D.block("b6m", "b8", "p", TEXT.b6, [ref.b.b8, ref.b.b6]);                      // the move: a new block that cites the old one ...
  ref.M1 = D.retract([ref.b.b6], "moved below Liability");                                  // ... and the old one is retracted (it stays as a tombstone)
  ref.N1 = E.note("b8", "Legal: is a 2x cap acceptable to Contoso?", [ref.b.b8]);
  const M2 = dirOf("M2"); union(M2, { alice: base, bob: rep.bob, carol: rep.carol, dana: rep.dana, erin: rep.erin });

  // ---- round 3 (concurrent, from the merge)
  const r3 = Object.fromEntries(["erin", "bob", "carol"].map((w) => [w, dirOf("r3-" + w)])); for (const d of Object.values(r3)) copy(M2, d);
  const E3 = writer(r3.erin, "erin"), B3 = writer(r3.bob, "bob"), C3 = writer(r3.carol, "carol");
  ref.T5 = E3.text("b4", "The term shall continue for thirty (30) months from the Effective Date.", [ref.T1, ref.T3]);                       // resolves the conflict: cites both sides
  ref.T6 = E3.text("b2", "This Amendment is entered into as of **April 1, 2026** between Northwind Traders and Contoso Ltd.", [ref.T4]);   // builds on dana's edit
  ref.D1 = E3.retract([ref.b10], "late-payment clause removed");
  ref.T7 = B3.text("b10", "Late payments accrue interest at 2% per month.", [ref.b10]);                                                   // bob edits what erin deletes
  ref.T8 = C3.text("b8", TEXT.b8, [ref.T2]);                                                                                                // carol reverts
  const M3 = dirOf("M3"); union(M3, { alice: base, bob: r3.bob, carol: r3.carol, dana: rep.dana, erin: r3.erin });
  return { lib, ref, M2, M3, base, entriesIn: (dir) => P.entries(P.open("doc", { dir, writer: "reader", frame: false })).length };
}
