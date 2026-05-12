# Etsy Draft Listing Assistant

A guided desktop app that turns a folder of product photos into Etsy draft listings using Anthropic Claude. Built for non-technical sellers running 2–3 small Etsy shops.

---

## What it does

A 5-step wizard:

1. **Setup** — point at a photo folder, set the listing policy text appended to descriptions
2. **Choose photos** — file-explorer browser; click photos to add them in order; the first one gets a **COVER** badge
3. **Item details** — what it is, price, quantity, era, readiness state, shipping profile, plus a free-text "anything the photos don't show?" catch-all
4. **Review AI listing** — Claude returns title, description, tags, alt text, and matches the Etsy taxonomy automatically
5. **Create Etsy draft** — uploads the listing as an unpublished draft on Etsy with the photos in the chosen order

The app supports up to 2 Etsy stores, each with its own OAuth, shipping profiles, readiness states, and last-used folder. Drafts are never published — final review and publish always happen in Etsy's seller dashboard.

---

## Prerequisites

For the **administrator** setting up the app:

- **Node.js 20+** (only needed to build the desktop app — the end user does not need Node)
- An **Anthropic API key** — https://console.anthropic.com/
- An **Etsy developer app** registered at https://www.etsy.com/developers/your-apps with:
  - Scopes: `listings_r listings_w shops_r`
  - Redirect URI matching exactly what you put in `.env` (e.g., `http://localhost:3000/auth/etsy/callback`)

For the **end user** running the packaged app:

- Windows 10 or 11
- The installed `.exe` (built by the administrator below)
- A folder of product photos (OneDrive / Google Drive / local folder all fine)

---

## First-time setup (administrator)

1. Clone or copy this repo to your machine and open a terminal in the project folder.

2. Install dependencies:
   ```powershell
   npm install
   ```

3. Build the Windows installer:
   ```powershell
   npm run build:win
   ```
   Output lands in `dist-electron/`. You'll get both:
   - `Etsy Draft Listing Assistant Setup <version>.exe` — installer (NSIS)
   - `Etsy Draft Listing Assistant <version>.exe` — portable single-file build

4. Copy the installer to the user's machine and run it. By default it installs to `C:\Program Files\Etsy Draft Listing Assistant\` and creates a Desktop shortcut.

5. **First launch** seeds an empty `.env` at:
   ```
   %APPDATA%\Etsy Draft Listing Assistant\.env
   ```
   Open that file in Notepad and fill in:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ETSY_CLIENT_ID=your_etsy_keystring
   ETSY_X_API_KEY=your_etsy_keystring:your_shared_secret
   ETSY_REDIRECT_URI=http://localhost:3000/auth/etsy/callback
   ```
   Save, then restart the app. The yellow "Setup needed" banner at the top of the app disappears once all four keys are present.

6. Inside the app, click the connection pill (top-right) for each store you want to use → it opens Etsy's OAuth flow in the user's default browser → after granting permission, the app auto-fetches the shop name and shop ID.

---

## Daily usage (end user)

Double-click the desktop shortcut → the app opens in its own window.

- Connection state is shown by the pill in the top-right:
  - **Green pill** = connected; clicking it opens a menu to **Disconnect** that store
  - **Amber pill** = not connected; clicking it starts Etsy OAuth in the user's browser
  - **Red pill** = something is wrong (server offline, etc.)
- The store switcher next to the pill is **only available on Step 1**. To switch stores mid-flow, return to Step 1.
- After a draft is created, click **New Listing** to start over.

---

## Where things live

| What | Path |
|---|---|
| `.env` (API keys) | `%APPDATA%\Etsy Draft Listing Assistant\.env` |
| App config (folder, policy, store labels) | `%APPDATA%\Etsy Draft Listing Assistant\data\config.json` |
| Etsy OAuth tokens | `%APPDATA%\Etsy Draft Listing Assistant\data\etsy_tokens.json` |
| Generated listing records | `%APPDATA%\Etsy Draft Listing Assistant\data\items.json` |
| Photo thumbnail cache | `%APPDATA%\Etsy Draft Listing Assistant\data\thumb-cache\` |

You can open this folder from inside the app: **File menu → Open config folder**.

---

## Rotating API keys

If you need to update the Anthropic key or Etsy credentials:

1. Close the app
2. Edit `%APPDATA%\Etsy Draft Listing Assistant\.env`
3. Save and reopen the app

OAuth tokens (the per-store Etsy access/refresh tokens) refresh automatically — you only edit `.env` when the long-lived API keys themselves change, which is rare.

---

## Sending the activity log to support

Inside the app:

1. Scroll to the bottom and click **Activity log** to expand it
2. Click **Copy log to send to support**
3. Paste into an email or chat to whoever is helping

What gets included in the support bundle:

- App version, Node/Electron versions, OS/arch, server start time
- Whether each required `.env` key is set (no actual key values)
- Sync folder path + accessibility check, listing policy length, active store
- Per-store: connection status, token expiry, scopes, shop ID, last folder, defaults
- File presence checks (`config.json`, `etsy_tokens.json`, `.env`, etc.)
- Wizard state (current step, photo count, AI taxonomy match, etc.)
- Browser/window info (user agent, locale, theme, timezone)
- The last 200 activity log entries — including any technical detail logged from API errors

What's **not** included: API keys, OAuth access/refresh tokens, photo contents.

---

## Updating to a new version

### Auto-update (preferred, after v0.2.2+)

Starting with v0.2.2, the installed app checks `https://github.com/devinfavin/etsy-draft-listing-app/releases/latest` on startup. If a newer version is found, it downloads in the background and prompts the user with a native dialog: *"Etsy Draft Listing Assistant X.Y.Z is ready to install. Install and restart, or later?"* — one click installs and relaunches. `%APPDATA%` is preserved through every update.

The user can also manually trigger a check via **File menu → Check for updates**.

**Publishing a new version** (administrator):

1. Set your GitHub token as an environment variable (one-time setup per machine):
   ```powershell
   [System.Environment]::SetEnvironmentVariable("GH_TOKEN", "github_pat_...", "User")
   ```
   The token needs `repo` scope (classic PAT) or "Contents: read/write" (fine-grained PAT scoped to this single repo). Generate at https://github.com/settings/tokens. **Open a fresh PowerShell window** after running this so it picks up the value.

2. Edit `release-notes.md` at the project root with **plain-English notes** describing what changed in this version. The user sees this content as a popup the first time they launch the app after the update — so write it for a non-technical reader, not for a git commit log. Overwrite the previous version's notes; only the current release needs to be in this file.

3. Bump the version, build, and publish in one go:
   ```powershell
   npm version patch       # 0.2.5 → 0.2.6 (or use 'minor' / 'major')
   npm run publish:win     # builds the installer AND uploads to GitHub Releases
   ```
   This creates a new GitHub release with the `.exe`, the `latest.yml` manifest, and your `release-notes.md` content as the release body.

4. Commit and push the version bump + the updated release notes:
   ```powershell
   git push origin main --follow-tags
   ```

That's it. Within a minute or so, every installed copy of the app will see the new release and offer to update; once installed, the user gets the plain-English summary popup on first launch.

### Manual update (fallback for pre-v0.2.2 installs or air-gapped machines)

1. Build the new installer: `npm run build:win`
2. Copy `dist-electron\Etsy Draft Listing Assistant Setup <version>.exe` to the user's PC
3. Run it — NSIS detects the prior install and replaces files in place

**What's preserved across updates:** the user's `.env`, store config, OAuth tokens, last-used folder, photo thumbnail cache — everything in `%APPDATA%\Etsy Draft Listing Assistant\`.

**What changes:** the application files in `Program Files\Etsy Draft Listing Assistant\` (the `.exe`, bundled Node modules, public assets).

The Desktop and Start Menu shortcuts continue to work after the update.

---

## Uninstalling

1. Windows Settings → **Apps** → **Installed apps** → search **Etsy Draft Listing**
2. Click the `…` menu → **Uninstall**

This removes the program files and shortcuts. It does **not** delete `%APPDATA%\Etsy Draft Listing Assistant\` (config, tokens, folder memory). If you want a fully clean removal, manually delete that folder afterward.

---

## Development workflow

Run the web app without Electron (just the Express server in your browser):

```powershell
npm start
```
Then open http://localhost:3000.

Run inside Electron locally without building an installer:

```powershell
npm run electron
```

Build only the portable `.exe` (no installer):

```powershell
npm run build:portable
```

### Adding an app icon

The build works fine without a custom icon — electron-builder falls back to the default Electron icon. To brand the installer, taskbar entry, and window:

1. Create a `build/` folder at the project root.
2. Place a Windows `.ico` at `build/icon.ico`. Recommended: a multi-resolution `.ico` containing 16x16, 24x24, 32x32, 48x48, 64x64, 128x128, 256x256.
3. Re-run `npm run build:win`.

**Quick way to make one from a PNG:**
- https://cloudconvert.com/png-to-ico (drop in a 512x512+ PNG, export as multi-resolution `.ico`)
- ImageMagick: `magick convert source.png -define icon:auto-resize=256,128,64,48,32,16 build/icon.ico`

electron-builder auto-detects `build/icon.ico` — no `package.json` changes needed.

---

## Architecture notes

- **Frontend**: vanilla HTML/CSS/JS in `public/` — no framework
- **Backend**: Node.js + Express in `server.js`
- **AI**: Anthropic Claude (`/v1/messages`) via tool-use for structured JSON output, with vision for photo analysis
- **Etsy**: Open API v3 with OAuth2 + PKCE, taxonomy auto-match, shipping/readiness lookup
- **Desktop wrapper**: Electron main process boots the Express server in the same Node runtime, then opens a `BrowserWindow` pointed at `http://localhost:3000`. OAuth is delegated to the user's default browser via `shell.openExternal`.

---

## Limitations / known behaviors

- **Vision capped at 10 photos** per listing (Claude API limit). The Step 2 banner warns if you select more.
- **Drafts only** — by design. Final publish always happens in the Etsy seller dashboard.
- **Partial-upload failure**: if image upload fails partway through draft creation, the draft will still exist on Etsy with whatever images uploaded successfully. Check the Etsy dashboard.
- **HEIC/HEIF** photos are accepted but JPG/PNG/WebP give the most reliable AI analysis.
- **No code signing**: unsigned `.exe` will show "unknown publisher" on first launch. Click "More info → Run anyway" or invest in a code-signing certificate (~$200/yr).

---

## Security

- Tokens and keys live only on the user's machine, in `%APPDATA%\Etsy Draft Listing Assistant\`.
- Don't share the contents of that folder. The activity log copy button strips sensitive data, but `data/etsy_tokens.json` and `.env` should be treated as secrets.
- This app is designed for single-user local use. Don't expose it on a network without adding authentication.
