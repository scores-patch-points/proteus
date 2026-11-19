// placements.mjs: the picture track of a sequence, READ FROM THE PHAROS. Slate (or any editor) weaves `placement` entries; Proteus reads them by kind and
// never calls the editor. A placement's `path` is as the editor's log stores it, often relative to the project folder, so the caller says where that is.
// Contract (the placement body): { project, sequence, track, s, e, in, out, clip, source, path }. Only track V1 is folded. Crop is "" unless told.
import fs from "node:fs"; import path from "node:path";
import { essence } from "./essence.mjs"; import { VfileError } from "./pfile.mjs";

export function clipsFromPlacements(ph, { project, sequence, root = null, crop = "" }) {
  const all = ph.L.P.fold(ph.reader(), { kind: "placement" }).entries.filter((e) => e.body && e.body.project === project && e.body.sequence === sequence && e.body.path);
  const es = all.filter((e) => String(e.body.track || "").toUpperCase() === "V1"), as = all.filter((e) => String(e.body.track || "").toUpperCase() === "A1");
  if (!es.length) throw new VfileError("no_picture", `no live V1 placement with a path for ${project}/${sequence} in ${ph.name}`);
  const clips = es.map((e) => {
    const b = e.body, p = path.isAbsolute(String(b.path)) ? String(b.path) : root ? path.resolve(root, String(b.path)) : null;
    if (!p || !fs.existsSync(p)) throw new VfileError("no_file", `placement ${e.id.slice(0, 8)} names ${b.path}, which is not at ${p || "(no --root given for a relative path)"}`, { placement: e.id });
    const real = fs.realpathSync(p); return { s: +b.s, e: +b.e, in: +b.in, path: real, media: essence(real), crop };
  });
  // The edit's sound is the A1 track when the sequence has one (sound can differ from the picture's own: cut away, mute, replace). Without A1, a clip's own sound is used.
  const place = (e) => { const b = e.body, p = path.isAbsolute(String(b.path)) ? String(b.path) : root ? path.resolve(root, String(b.path)) : null;
    if (!p || !fs.existsSync(p)) throw new VfileError("no_file", `placement ${e.id.slice(0, 8)} names ${b.path}, which is not at ${p || "(no --root given for a relative path)"}`, { placement: e.id }); const real = fs.realpathSync(p); return { s: +b.s, e: +b.e, in: +b.in, path: real, media: essence(real), crop: "" }; };
  const aclips = as.length ? as.map(place) : null;
  return { clips, aclips, total: Math.max(...clips.map((c) => c.e)), cites: [...es, ...as].map((e) => e.id) };
}
