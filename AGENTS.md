# Proteus: instructions for AI agents

Proteus makes projected files (today: the virtual mp4 of an edit) from what other repos wrote to the pharos, and weaves the recipe (`vfile`) and the evidence (`vfile-check`). It honours the management entries EODB weaves (`vfile-pin`, `vfile-evict`). Read `README.md` and `docs/VFILE.md` first.

## Standing rules
These are carried from the folder this repo lives in, where they apply to every AI session. They are written here so they travel with the repo.

1. **Repos never call each other.** Proteus reads and writes pharos entries by cell and kind, and nothing else crosses a repo boundary. Do not import another repo's code. The one thing loaded from outside is the pharos library, through the sha256-pinned pointer in `door/pharos.json` (`node <pharos>/bin/pharos.mjs verify pharos-core --target door`). If a feature needs another repo, write down the entry shape it would use; do not add a call.
2. **Never make a clip file that is only a time-cut of a longer source.** Keep the full source and record the range as a selection. Proteus's chunks are the one thing that looks like a cut: they are conformed (crop, 16:9 scale, 24 fps, all-intra), they live only in the rebuildable chunk cache (`SLATE_VFOLD_CACHE`, default under `~/.cache`), and they are never a deliverable. Never export, hand over or place a chunk as an asset. A cut gate is enforced by hooks in the local session settings: never reword a command to get past it, never read or edit its files; if it blocks you, tell the user plainly what it costs, ask, and wait.
3. **A request about a person's statements, a recording, a clip or a quote goes through the editing pipeline's own tools** (find, quote and verify there), not through guesses from file names. Proteus is not that pipeline.
4. **The log is the ledger; everything derived is a cache.** Recipes and evidence go in the pharos as entries. Bytes and chunks never do. Retract by weaving, never erase.
5. **Named authors.** Every weave has a named writer (`by`), one file per writer. Do not write another writer's file.
6. **Do not push, merge or change user-level configuration without the owner's yes.** Commit only paths you can name. Do not publish another person's work or downloaded material.
7. **Say what you did not measure.** A determinism result is one machine and one ffmpeg until it is shown on more. Report failures with their output.

## Run
`npm test` needs ffmpeg and ffprobe, and the pharos repo beside this one (the door's pointer is `../../pharos/lib/pharos.mjs` from `door/`). 16 tests.
