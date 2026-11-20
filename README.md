# Proteus

Makes projected files from what other repos wrote to the pharos, and weaves the recipe and the evidence. Today it makes one kind: the **virtual mp4** of an edit (a computed header over cached all-intra chunks, no render per edit). It takes any shape asked of it; nothing is stored until a range is read.

**Who does what.**

| | Does | Never does |
|---|---|---|
| **Slate** | edits video; weaves `placement` entries | build virtual files |
| **Proteus** (this repo) | reads placements by kind; builds the files; weaves `vfile` (recipe) and `vfile-check` (evidence) | decide what to keep, who may read, or when to delete |
| **EODB** | manages the files: weaves `vfile-pin` and `vfile-evict` entries | build bytes |
| **Pharos** | the ledger: every recipe, check, retraction and management entry | run code |

**Repos never call each other.** They write and read pharos entries by cell and kind; the entry shapes are the contract ([docs/VFILE.md](docs/VFILE.md)). Proteus loads one thing from outside: the pharos library, through the sha256-pinned pointer in `door/pharos.json` (`node pharos/bin/pharos.mjs verify pharos-core --target proteus/door`).

```
proteus record --project P --sequence S --root <project folder>   # weave the recipe: pure, instant, no ffmpeg
proteus record ... --build [--deep] [--audio] [--lg]                               # also build the header (ffmpeg for uncached chunks) and record size + hash
proteus check  --project P --sequence S [--deep]                  # rebuild from the recorded recipe alone; weave the result
proteus status --project P --sequence S                           # the live recipe and the latest check (reads only the pharos)
proteus serve [--port 8787]                                       # serve every live recipe at /v/<recipe>.mp4 by byte range (HEAD, Range, 416); 127.0.0.1 only
proteus export --project P --sequence S --to FILE   # write a recipe out as a real, verified file (or --recipe <prefix> for an old version); weaves vfile-export
proteus exports [--project P] [--verify]            # what has been written out: present, changed, missing, or stale (a newer recipe replaced it)
proteus sweep [--dry]                                             # honour EODB's vfile-evict / vfile-pin entries: drop only the cached chunks nothing else needs, weave vfile-evicted
# common: --pharos <folder|name> (default $PHAROS, then ~/.pharos/proteus)   --by <writer>
```

`npm test` (needs ffmpeg and ffprobe; 16 tests). Layout: `lib/pfile.mjs` the generic protocol (imports only `node:crypto`), `lib/vfile.mjs` + `lib/vfold.mjs` the video projector, `lib/placements.mjs` reads the editor's placements, `lib/manage.mjs` honours EODB's pin and evict entries, `lib/door.mjs` the pharos door, `lib/essence.mjs` content ids for media.

`lib/vfold.mjs`, `lib/essence.mjs` and `lib/atomic.mjs` are copies of Slate's (Slate keeps its own for its timeline preview). Proteus cannot import Slate, so the duplication is deliberate and will drift unless someone keeps them in step.
