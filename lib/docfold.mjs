// docfold.mjs: a Word document folded out of the pharos, to test that the protocol is not about video. Several writers weave edits (each in their own copy of the log, merged by
// union); Proteus reads them by kind, folds them to a document, writes the recipe, and can rebuild it from the recipe alone.
//   doc-block (INS·Figure)  a paragraph. body { doc, id, after, style, text, lc }.  `after` is the block it follows (null = first); `of` cites the anchor's entry.
//   doc-text  (REC·Figure)  a new text for a block. body { doc, block, text, lc }.   `of` cites what it was made from: the block, or the earlier text(s) it supersedes. Two edits that
//                           do not cite each other are CONCURRENT: the pharos fold reports them as a conflict, and the fold here resolves by a written rule and keeps the loser as a comment.
//   doc-note  (EVA·Figure)  a comment from a writer. body { doc, block, text, lc }.
//   delete = a retraction of the block's entry (the block stays as a tombstone, so what was anchored after it keeps its place). A move = retract + a new block citing the old one.
// ORDER. Blocks form a tree by `after`; siblings are ordered by a Lamport counter `lc` the writer set (newer first), ties by entry id. This is the usual sequence-CRDT rule and it uses
// nothing but the entries, so the document is a pure function of the set of entries: the recipe is that set (ids are content hashes), and a rebuild needs only the pharos.
// WHAT THE PHAROS DOES: union of writers' files, which entries are live (retractions, including a retraction of a retraction), concurrent-edit conflicts. Variants (WITHOUT a writer, AS OF an
// entry) are made in a scratch copy by weaving retractions, so they use the pharos's own rules and the main log is never touched.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";
import * as PF from "./pfile.mjs"; import { renderDocx, diffWords } from "./docx.mjs"; import { Pharos } from "./door.mjs";

export const DOC_PROJECTOR = "docfold@v1";
export const DOC_KINDS = { "doc-block": "INS·Figure", "doc-text": "REC·Figure", "doc-note": "EVA·Figure" };
const STYLE = { h1: "Heading1", h2: "Heading2", li: "ListParagraph", p: "Normal" };
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const ord = (a, b) => (a.body.lc - b.body.lc) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** the document, as a model, from a set of entries (by id). Pure: nothing but the entries decides it. */
export function modelFrom({ doc, owner, entries, live, dead }) {
  const E = (id) => entries.get(id), blocks = new Map(), texts = new Map(), notes = new Map(), group = (m, k, e) => (m.get(k) || m.set(k, []).get(k)).push(e);
  for (const id of live) { const e = E(id); if (!e) continue; if (e.kind === "doc-block") blocks.set(e.body.id, { e, dead: null }); else if (e.kind === "doc-text") group(texts, e.body.block, e); else if (e.kind === "doc-note") group(notes, e.body.block, e); }
  for (const pair of dead) { const [bid, rid] = pair.split(":"), be = E(bid), re = E(rid); blocks.set(be.body.id, { e: be, dead: re }); }
  const kids = new Map(); for (const x of blocks.values()) group(kids, x.e.body.after || "", x); for (const l of kids.values()) l.sort((a, b) => ord(b.e, a.e));      // newer first
  const order = [], stack = [...(kids.get("") || [])].reverse(); while (stack.length) { const x = stack.pop(); order.push(x); const k = kids.get(x.e.body.id) || []; for (let i = k.length - 1; i >= 0; i--) stack.push(k[i]); }
  const resolveText = (x) => {
    const be = x.e, ts = texts.get(be.body.id) || [], cited = new Set(ts.flatMap((t) => t.of)), heads = ts.filter((t) => !cited.has(t.id)).sort(ord);
    if (!heads.length) return { text: be.body.text, by: be.by, at: be.at, base: null, heads: [], losers: [] };
    const win = heads.at(-1), tp = win.of.map(E).filter((p) => p && p.kind === "doc-text").sort(ord);                      // a merge cites several heads: show the change against the strongest
    return { text: win.body.text, by: win.by, at: win.at, base: tp.length ? tp.at(-1).body.text : be.body.text, heads, losers: heads.slice(0, -1), win };
  };
  const paras = [], conflicts = []; let created = null, modified = null;
  for (const x of order) {
    const b = x.e.body, style = STYLE[b.style] || "Normal";
    if (x.dead) { paras.push({ block: b.id, state: "deleted", style, segs: [{ t: "eq", text: b.text }], insertedBy: null, deletedBy: { by: x.dead.by, at: x.dead.at }, comments: [] }); continue; }
    const r = resolveText(x); if (r.heads.length > 1) conflicts.push({ block: b.id, by: r.heads.map((h) => h.by), entries: r.heads.map((h) => h.id), winner: r.win.id });
    const segs = r.base == null ? [{ t: "eq", text: r.text }] : diffWords(r.base, r.text).map((s) => ({ ...s, by: r.by, at: r.at }));
    const comments = [...(notes.get(b.id) || []).sort(ord).map((n) => ({ by: n.by, at: n.at, text: n.body.text })), ...r.losers.map((l) => ({ by: l.by, at: l.at, text: `Concurrent edit, not applied: ${l.body.text}` }))];
    const derived = x.e.of.some((id) => E(id) && E(id).kind === "doc-block" && E(id).body.id !== b.after);               // cites a block that is not its anchor: it was made from that block (a move)
    paras.push({ block: b.id, state: "live", style, segs, insertedBy: x.e.by !== owner || derived ? { by: x.e.by, at: x.e.at } : null, deletedBy: null, comments });
  }
  const used = [...live, ...dead.flatMap((p) => p.split(":"))].map(E).filter((e) => e && e.kind.startsWith("doc-")), ats = used.map((e) => e.at).sort(); created = ats[0]; modified = ats.at(-1);      // only entries the recipe NAMES: anything else in the log must not change the file
  const orphans = [...texts.keys()].filter((k) => !blocks.has(k) || blocks.get(k).dead).reduce((n, k) => n + texts.get(k).length, 0);
  return { title: doc, owner, created, modified, paras, conflicts, orphans };
}

/** which entries are live for a document in this pharos, and which blocks are dead (block entry : the retract entry that killed it). */
export function snapshot(ph, doc) {
  const P = ph.L.P, r = ph.reader(), f = P.fold(r), mine = f.entries.filter((e) => e.kind in DOC_KINDS && e.body && e.body.doc === doc);
  const live = mine.map((e) => e.id), liveSet = new Set(live), eff = new Map(); for (const t of f.retractions) if (t.by !== "whatif") for (const id of t.of) eff.set(id, t.id);      // a variant's own removals are not deletions: they are not in the main log, so a recipe must not name them
  const dead = P.entries(r).filter((e) => e.kind === "doc-block" && e.body && e.body.doc === doc && !liveSet.has(e.id) && eff.has(e.id)).map((e) => `${e.id}:${eff.get(e.id)}`);
  return { live, dead, conflicts: f.conflicts.filter((c) => String(c.addr).startsWith(`text:${doc}:`)) };
}

/** the projector. `ph` is the ORIGINAL pharos: every entry a recipe names is looked up there, whatever variant it was made from. */
export function docProjector(ph) {
  const lookup = () => new Map(ph.L.P.entries(ph.reader()).map((e) => [e.id, e]));
  return {
    name: DOC_PROJECTOR,
    identity({ doc, owner, live, dead }) { return { projector: DOC_PROJECTOR, doc, owner, live: [...live].sort(), dead: [...dead].sort() }; },
    where() { return {}; },
    inputsFromBody(body) { const m = lookup(), missing = [...body.live, ...body.dead.flatMap((p) => p.split(":"))].filter((id) => !m.has(id)); return { inputs: { doc: body.doc, owner: body.owner, live: body.live, dead: body.dead, entries: m }, missing }; },
    async build(inputs) { const t0 = Date.now(), model = modelFrom(inputs), bytes = renderDocx(model), h = sha(bytes); return { size: bytes.length, header_sha256: h, file_sha256: h, chunks: model.paras.length, ms: Date.now() - t0, made: 0, v: { bytes, model } }; },
  };
}

/** a scratch copy of the log with a set of entries retracted, by weaving (the pharos's own rule). Never touches `ph`. */
export function variantReplica(ph, { exclude = [], asof = null }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docvar-")); fs.cpSync(ph.dir, tmp, { recursive: true });
  const rep = new Pharos({ dir: tmp, lib: ph.L, doorDir: ph.doorDir }), all = ph.L.P.entries(ph.reader()), byId = new Map(all.map((e) => [e.id, e])), skip = (e) => ["kind", "holon", "frame"].includes(e.kind);               // declarations are never part of a variant; a retraction IS (retracting a retraction restores what it removed)
  const R = new Set();
  if (exclude.length) {                                                                                        // WITHOUT writers: their entries, and (to a fixpoint) every entry that cites one of them
    for (const e of all) if (exclude.includes(e.by) && !skip(e)) R.add(e.id);
    for (let grew = true; grew;) { grew = false; for (const e of all) if (!R.has(e.id) && !skip(e) && e.of.some((id) => R.has(id))) { R.add(e.id); grew = true; } }
  }
  if (asof) {                                                                                                  // AS OF an entry: only its causal past (seen and of, transitively)
    const past = new Set(), st = [asof]; while (st.length) { const id = st.pop(); if (past.has(id) || !byId.has(id)) continue; past.add(id); const e = byId.get(id); st.push(...e.seen, ...e.of); }
    for (const e of all) if (!past.has(e.id) && !skip(e)) R.add(e.id);
  }
  if (R.size) rep.retract("whatif", [...R], { why: `variant: ${exclude.length ? "without " + exclude.join(", ") : ""}${asof ? "as of " + asof.slice(0, 12) : ""}` });
  return rep;
}

/** record a document (or a variant of it under another branch name) as a vfile entry in `ph`. */
export async function recordDoc(ph, by, { doc, owner, branch = "main", exclude = [], asof = null }) {
  const view = exclude.length || asof ? variantReplica(ph, { exclude, asof }) : ph, snap = snapshot(view, doc), entries = new Map(ph.L.P.entries(ph.reader()).map((e) => [e.id, e]));
  try { return { ...(await PF.record(ph, by, { project: doc, sequence: branch, inputs: { doc, owner, live: snap.live, dead: snap.dead, entries }, cite: snap.live }, { projector: docProjector(ph) })), conflicts: snap.conflicts }; }
  finally { if (view !== ph) fs.rmSync(view.dir, { recursive: true, force: true }); }
}
export const openDoc = (ph, doc, branch = "main", opts = {}) => PF.open(ph, { project: doc, sequence: branch }, { projector: docProjector(ph), ...opts });
export const checkDoc = (ph, by, doc, branch = "main", opts = {}) => PF.check(ph, by, { project: doc, sequence: branch }, { projector: docProjector(ph), ...opts });
