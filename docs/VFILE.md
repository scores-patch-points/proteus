# Virtual files on the pharos

**Who does what.** Slate edits and weaves `placement` entries. **Proteus creates the files** and weaves their recipes and evidence. **EODB manages them** (what to keep, who may read, deletion). **The ledger is the pharos.** Repos never call each other: they write and read entries by cell and kind, and the entry shapes below are the contract.

`lib/vfold.mjs` makes the picture of an edit as a **virtual mp4**: a computed header (ftyp + moov whose sample table points at frames inside cached all-intra chunks) and the chunks' bytes, served by byte range. An edit changes only the sample table, so it costs milliseconds plus any chunk not yet seen.

## Contract: what other repos rely on

`vfile` (SYN·Pattern), addr `vfile:<project>:<sequence>`, `of` = the placements it was made from. Body: `project`, `sequence`, `projector` (name and version, e.g. `vfold@v2`), `recipe` (sha256 of the canonical identity object), the identity fields (for vfold: `fps`, `chunk`, `w`, `h`, `frames`, `clips` as `{s, e, in, media, crop}`), `where` (content id to path hint), `size`, `header_sha256`, `chunks`, and `file_sha256` when a deep build was recorded. `size`, `header_sha256` and `chunks` are null when the recipe was woven without a build. One live entry per addr: a new recipe retracts the old one (never erases it); an unchanged recipe and bytes weave nothing.

`vfile-check` (EVA·Pattern), addr `vfile-check:<project>:<sequence>:<recipe prefix>`, `of` = the `vfile` entry. Body: `recipe`, `result` (`identical`, `differs`, `unavailable`, `recipe_mismatch`, `unrecorded`), `expected`, `found`, `missing` (content ids), `ms`, `chunks_made`.

`placement` (INS·Figure) is **Slate's** kind, read here and never declared: `{ project, sequence, track, s, e, in, out, clip, source, path }`. `path` is as the editor's log stores it, often relative to the project folder, so Proteus is told the project folder (`--root`). Only track V1 is folded; crop is "" unless told.

### Management entries (EODB writes, Proteus honours)

`vfile-pin` (DEF·Figure), addr `vfile-pin:<recipe prefix>`, `of` = the `vfile` entry, body `{ recipe, why }`: hold this file's cached bytes. `vfile-evict` (SEG·Figure), addr `vfile-evict:<recipe prefix>`, `of` = the `vfile` entry, body `{ recipe, why, nonce }`: drop this file's cached bytes (the nonce makes each request a distinct entry, since the identical request twice is one entry in the pharos). Proteus answers with `vfile-evicted` (REC·Figure), addr `vfile-evicted:<evict id prefix>`, `of` = the request, body `{ recipe, evict, result, chunks_removed, bytes, shared_kept }`; `result` is `dropped`, `refused_pinned` or `no_such_file`.

**Chunks are shared** across edits (the cache is keyed by essence, crop and index), so Proteus deletes a chunk only if no live file that is pinned, or not under an evict request, still needs it; what a file needs is recomputed from its own clips. Eviction is a cache drop only: the recipe stays in the ledger and the bytes rebuild from the media (tested: after eviction the file rebuilds with the same size, header and file hash). These kinds are not the pharos's `keep` and `strike`, which mean a person's mark on a statement.

**Identity is by recipe, not path** (the Nix rule): the same clips from the same essence ids give the same recipe whatever the files are called; float noise below a microsecond is not a different edit; a clip with no essence id is refused.

**Not in the log:** the bytes and the chunks. Chunks are a cache keyed by `(essence, crop, index)` under `SLATE_VFOLD_CACHE` (the variable keeps Slate's name because the copied vfold reads it); delete it and the only cost is time. An entry is about 100 bytes per clip however long the video is.

## Layers in this repo

| File | What |
|---|---|
| `lib/pfile.mjs` | the protocol: recipe identity, record, open, check. Generic: imports only `node:crypto`. A projector is `{ name, identity, where, inputsFromBody, build }`. |
| `lib/vfile.mjs` | the vfold projector: clips to a plan, a header over cached chunks, essence ids |
| `lib/placements.mjs` | reads Slate's placements by kind and makes the clips |
| `lib/door.mjs` | the pharos door (pinned library, per-writer handles, declares `vfile`, `vfile-check` and the holon) |

## Measured (test/vfile.test.mjs, one Mac, two synthetic 640x360 sources of 6 s, two 4 s chunks each)

- A second pharos connection that knew nothing of the first found the recipe by kind, rebuilt the file from the media alone, and got the same size and header hash. The file is a real mp4 (ffprobe: 1280x720, 24/1, 144 frames, 6 s).
- **Determinism, measured:** after deleting the whole chunk cache, rebuilding re-encoded the chunks and the size, header hash and **the sha256 of every byte** came back identical. One machine, one ffmpeg, one run, tiny sources. Nothing assumes it: whatever a rebuild gives is what `vfile-check` records, so a machine or encoder that does not reproduce the bytes shows up as `differs`.
- Proteus built a file from placements alone: relative paths resolved against the project folder, a moved clip followed (the retracted placement is ignored, the recipe changes), and the check came back identical.
- Slate's earlier door wrote a `vfile`, and Proteus's CLI read it correctly: the shapes agree across the two codebases.

## Not done

- **Management is thin.** EODB's policy is only "keep the newest N per project, unless pinned" (N is a stated constant). Neither side knows cache sizes or when a file was last played, so nothing evicts by pressure or by use.
- **Requests.** Nothing lets another repo ask Proteus for a build by weaving a `request` entry.
- **Serving.** Nothing serves a virtual file from a recipe id; `open` returns the file object and `readRange` reads it.
- **Only V1 picture** is folded. Audio, overlays and fx are not part of the recipe, and crop comes from the caller, not from the placement.
- **Other projectors.** The piece-table wav in Slate is not recorded here; the protocol takes any projector (a toy text projector in the tests exercises it), but only `vfold@v2` is real.
- **Copies.** `vfold`, `essence` and `atomic` are copies of Slate's files and will drift unless kept in step.
