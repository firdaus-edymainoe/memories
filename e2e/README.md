# Desktop e2e tests

Playwright tests for the desktop app: the local API (Hono + SQLite + file system), the React UI
talking to it, and the Electron shell.

```bash
npm ci
npx playwright install chromium        # once
npm run test:e2e:xvfb                  # Linux: everything, Electron under a virtual display
npm run test:e2e                       # macOS / Windows (or Linux without Electron: it self-skips)
npm run test:e2e:api                   # API only, no browser (~5 s)
npm run test:e2e:web                   # UI in Chromium
npm run test:e2e:electron              # Electron only (needs a display; on Linux prefix xvfb-run -a)
```

The UI dev server (`npm run dev:ui`, port 5173) is started by Playwright, or reused if it is already
running locally. Nothing else needs to be running.

## How it is isolated

- **One API process per worker** (`support/api-server.ts`): `apps/desktop/src/serve.ts` on a random port with
  `MEMORIES_TEST_MODE=1` and its own `MEMORIES_DB` in a temp folder. Tests never touch the real catalog;
  test mode refuses to start without `MEMORIES_DB`.
- **Reset between tests**: `POST /__test/reset` empties every table; each test gets its own fixture folder.
- **Fake drives**: `PUT /__test/volumes` replaces the plugged-in volume list (`mem.plugDrive()` / `mem.unplug()`).
- **Fake Android phone**: `PUT /__test/phones` plugs in a phone whose storage is a plain folder, served
  through the real `MtpFileIO` / `MtpVolumes` code. adb is never downloaded or run.
- **Pinned time**: `TZ=Asia/Kuala_Lumpur` for API and browser, `en-GB` locale, file mtimes pinned, and the
  page `Date` pinned to 2026-10-11 12:00 MYT (`support/clock.ts`).
- **No internet**: every page aborts requests that leave 127.0.0.1 and fails the test if any were made.
  The welcome tour's sample photos are stubbed with a local JPEG (`stubExternalHosts`).

The hooks live in `apps/desktop/src/test-hooks.ts` and are only loaded when `MEMORIES_TEST_MODE=1`;
`api/hooks.spec.ts` checks they 404 otherwise.

## Known bugs

Tests that document a bug call `knownBug("…")` (Playwright `test.fail`). They pass while the bug exists
and **fail when it is fixed**; then delete the `knownBug` line so the test guards the fix.
