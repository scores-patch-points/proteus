// docx.mjs: a .docx written from a model, byte-for-byte reproducible (fixed zip dates and order, deterministic deflate), with Word's own representation of multi-writer work:
// TRACKED CHANGES (w:ins / w:del carrying author and date) and COMMENTS. Nothing here knows the pharos; docfold.mjs hands it paragraphs.
//   para: { style: "Normal"|"Heading1"|"Heading2"|"ListParagraph", segs: [{ t: "eq"|"ins"|"del", text, by, at }], insertedBy: {by, at}|null, deletedBy: {by, at}|null,
//           comments: [{ by, at, text }] }
//   A paragraph whose mark is "inserted" shows as a tracked insertion; "deleted" as a tracked deletion (Word's Reject All brings it back, Accept All removes it).
//   Bold is written as **text** in the model. The zip is a minimal writer (central directory, CRC-32 from node:zlib).
import zlib from "node:zlib";

export function zip(files) {
  const locals = [], central = []; let off = 0; const date = (1 << 5) | 1;        // 1980-01-01 00:00:00: nothing in the file depends on when it was made
  for (const [name, data] of files) {
    const nameB = Buffer.from(name, "utf8"), comp = zlib.deflateRawSync(data, { level: 9 }), stored = comp.length >= data.length, body = stored ? data : comp, method = stored ? 0 : 8, crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameB.length, 26); locals.push(lh, nameB, body);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(off, 42); central.push(ch, nameB);
    off += 30 + nameB.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const iso = (at) => String(at || "2000-01-01T00:00:00.000Z").replace(/\.\d+Z$/, "Z");
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** **bold** toggles, everything else literal. `del` writes w:delText (a deleted run), otherwise w:t. */
function runs(text, del) {
  const parts = String(text).split("**"), out = [];
  parts.forEach((p, i) => { if (!p) return; const rpr = i % 2 ? "<w:rPr><w:b/></w:rPr>" : ""; out.push(`<w:r>${rpr}<${del ? "w:delText" : "w:t"} xml:space="preserve">${esc(p)}</${del ? "w:delText" : "w:t"}></w:r>`); });
  return out.join("");
}

export function renderDocx({ title = "Document", owner = "", created, modified, paras }) {
  let id = 0; const comments = [], body = [];
  const rev = (tag, who, inner) => `<w:${tag} w:id="${++id}" w:author="${esc(who.by)}" w:date="${iso(who.at)}">${inner}</w:${tag}>`;
  for (const p of paras) {
    const mark = p.insertedBy ? `<w:rPr>${rev("ins", p.insertedBy, "").replace(/><\/w:ins>$/, "/>")}</w:rPr>` : p.deletedBy ? `<w:rPr>${rev("del", p.deletedBy, "").replace(/><\/w:del>$/, "/>")}</w:rPr>` : "";
    let inner = p.segs.map((s) => {
      if (s.t === "ins") return rev("ins", s, runs(s.text, false));
      if (s.t === "del") return rev("del", s, runs(s.text, true));
      if (p.deletedBy) return rev("del", p.deletedBy, runs(s.text, true));
      if (p.insertedBy) return rev("ins", p.insertedBy, runs(s.text, false));
      return runs(s.text, false);
    }).join("");
    for (const c of p.comments || []) { const cid = ++id; comments.push({ id: cid, ...c }); inner = `<w:commentRangeStart w:id="${cid}"/>${inner}<w:commentRangeEnd w:id="${cid}"/><w:r><w:commentReference w:id="${cid}"/></w:r>`; }
    body.push(`<w:p><w:pPr><w:pStyle w:val="${p.style}"/>${mark}</w:pPr>${inner}</w:p>`);
  }
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const com = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${NS}>${comments.map((c) => `<w:comment w:id="${c.id}" w:author="${esc(c.by)}" w:date="${iso(c.at)}" w:initials="${esc(String(c.by).slice(0, 2).toUpperCase())}"><w:p><w:r><w:t xml:space="preserve">${esc(c.text)}</w:t></w:r></w:p></w:comment>`).join("")}</w:comments>`;
  const sty = (id, name, extra) => `<w:style w:type="paragraph" w:styleId="${id}"${id === "Normal" ? ' w:default="1"' : ""}><w:name w:val="${name}"/>${id === "Normal" ? "" : '<w:basedOn w:val="Normal"/>'}${extra}</w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + sty("Normal", "Normal", "") + sty("Heading1", "heading 1", '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr>')
    + sty("Heading2", "heading 2", '<w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr>') + sty("ListParagraph", "List Paragraph", '<w:pPr><w:ind w:left="720"/></w:pPr>') + "</w:styles>";
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>${esc(owner)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${iso(created)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso(modified)}</dcterms:modified></cp:coreProperties>`;
  const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
  const drels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>';
  const B = (s) => Buffer.from(s, "utf8");
  return zip([["[Content_Types].xml", B(ct)], ["_rels/.rels", B(rels)], ["docProps/core.xml", B(core)], ["word/document.xml", B(doc)], ["word/styles.xml", B(styles)], ["word/comments.xml", B(com)], ["word/_rels/document.xml.rels", B(drels)]]);
}

/** word-level diff: segments { t: "eq"|"ins"|"del", text }. Ties prefer a deletion before an insertion, so the output is deterministic. */
export function diffWords(a, b) {
  const A = String(a).split(/(\s+)/).filter((x) => x !== ""), B = String(b).split(/(\s+)/).filter((x) => x !== ""), n = A.length, m = B.length, W = m + 1, L = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
  const out = []; const push = (t, text) => { const l = out.at(-1); if (l && l.t === t) l.text += text; else out.push({ t, text }); };
  let i = 0, j = 0; while (i < n && j < m) { if (A[i] === B[j]) { push("eq", A[i]); i++; j++; } else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) push("del", A[i++]); else push("ins", B[j++]); }
  while (i < n) push("del", A[i++]); while (j < m) push("ins", B[j++]); return out;
}
