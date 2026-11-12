# Build & installers

```bash
cd apps/desktop
npm ci
npm run typecheck && npm test
export LICENSE_SERVER_URL=https://license.yourdomain.com
export LICENSE_PUBLIC_KEY="$(cd ../license-server && npm run -s print-public-key)"
npm run dist:linux   # AppImage + .deb
npm run dist:win     # NSIS installer (.exe)
npm run dist:mac     # .dmg + .zip
```

Output goes to `apps/desktop/release/<version>/`.

| Target | Where to build | Status in this delivery |
|---|---|---|
| Linux AppImage + .deb | Linux | **Built and launched** (`Lead Getter Enterprise-1.0.0.AppImage`, `lead-getter-enterprise_1.0.0_amd64.deb`) |
| Windows NSIS | Windows (recommended) or Linux with wine | App packaged for win32 x64; installer not produced on this machine (no wine) |
| macOS dmg/zip | **macOS only** (Apple tooling) | Not built — requires a Mac |

Notes:

* No native Node modules are used (SQLite comes from Node's built-in `node:sqlite`), so the same source builds on every OS without rebuild steps.
* **Code signing**: for Windows set `CSC_LINK`/`CSC_KEY_PASSWORD` (Authenticode certificate); for macOS set your Developer ID identity plus notarization (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Unsigned builds work but show SmartScreen/Gatekeeper warnings.
* Building the Windows NSIS installer on Linux requires **wine** (installer creation and exe resource editing both use it). Without wine, `-c.win.signAndEditExecutable=false` still packages the app folder (`win-unpacked`) but not the installer. Prefer building on Windows or in CI (`windows-latest`).
* **Auto-updates**: `electron-updater` is wired in (checks on start, notifies the UI, never auto-downloads). Set `publish.url` in `electron-builder.yml` to where you host `latest*.yml` + installers.
* The app stores data in its own directory (`lead-getter-enterprise`) and uses its own app id (`com.leadgetter.enterprise`), so it installs side-by-side with the original Lead Getter.

## Running from source

```bash
unset ELECTRON_RUN_AS_NODE     # VS Code terminals may set this
npm run dev
```

`LGE_USER_DATA=/tmp/profile` (development only) uses a throwaway profile; `LGE_CAPTURE_DIR=/tmp/shots` additionally seeds sample data into it and screenshots every page in both themes for visual QA.
