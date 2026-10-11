# Repository notes

- Read `README.md` before changing plugin behavior. For PDF and file-watch changes, also read `tests/electron/README.md`.
- `views/` is the checked-in production IIFE loaded through `file://`. After changing `views-src/`, run `pnpm typecheck`, `pnpm verify`, `pnpm build`, and the relevant isolated desktop checks so source and runtime agree.
- Keep PDF resources offline, and preserve the session-scoped document, Worker, Blob URL and listener cleanup. Use the matching PDF.js find controller instead of parsing text separately.
- File-watch guards must test the current open path with `isExternalPath`; the browser's global `external` is an object, not the file's location flag. Changes to dirty documents must warn without replacing the editor buffer.
- Desktop regression checks must use temporary projects/profiles and synthetic fixtures. Never point them at user PI-Desktop state or include QA dependencies and test files in runtime packages.
