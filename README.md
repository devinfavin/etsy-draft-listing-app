# Etsy Draft Listing App (Local MVP)

A local web app that helps you:

1. Read product photos from a synced cloud folder on your PC
2. Select photos for a listing
3. Fill out an intake form
4. Generate an Etsy-ready listing using OpenAI
5. Create an **Etsy draft (unpublished)** and upload selected images for final review

## What this MVP includes

- Local photo browser (recursive scan of your sync folder)
- Manual image selection and ordering
- Intake form in the same app
- AI-generated title/description/spec bullets/tags/materials/alt text
- Etsy OAuth connect (Authorization Code + PKCE)
- Etsy draft creation + image upload
- Local save of generated records (`data/items.json`)

## Requirements

- **Node.js 20+**
- An **OpenAI API key**
- An **Etsy developer app** (Open API v3)
- A synced photo folder (OneDrive, Google Drive for Desktop, Dropbox, iCloud for Windows, etc.)
- A valid **HTTPS callback URL** for Etsy OAuth (Etsy requires HTTPS redirect URIs)

## Setup

1. Install dependencies

```bash
npm install
```

2. Copy environment file

```bash
cp .env.example .env
```

3. Edit `.env` with your keys and Etsy OAuth config

Required:
- `OPENAI_API_KEY`
- `ETSY_CLIENT_ID`
- `ETSY_X_API_KEY`
- `ETSY_REDIRECT_URI`

4. Start the app

```bash
npm start
```

5. Open:
- `http://localhost:3000`

## Etsy OAuth note (important)

Etsy requires the redirect URI to be **HTTPS** and to match exactly what you configured in your Etsy app settings.

For local use, common options are:
- A reverse proxy with HTTPS on your machine/network
- An HTTPS tunnel (e.g., Cloudflare Tunnel / ngrok) mapped to `http://localhost:3000`

Then set `ETSY_REDIRECT_URI=https://your-domain/auth/etsy/callback` in `.env` and Etsy app settings.

## Etsy defaults you must configure in the app UI

Before creating drafts, set these under **Settings**:
- `shopId`
- `taxonomy_id`
- `shipping_profile_id`
- `readiness_state_id`
- `who_made`
- `when_made`

These are required for physical listings.

## Workflow

1. Set sync folder and Etsy defaults in **Settings**
2. Click **Refresh Photos**
3. Select listing photos and order them
4. Fill out intake form
5. Click **Generate Listing (AI)**
6. Review/edit generated title and description
7. Click **Create Etsy Draft (Unpublished)**
8. Review final draft in Etsy before publishing

## Notes / limitations (MVP)

- Etsy fields can vary by category/taxonomy. If Etsy rejects the listing request, the app logs the API error for adjustment.
- Tags/materials handling is implemented in a pragmatic way and may need refinement depending on your category rules.
- Vision (sending images to OpenAI) is optional and capped in this MVP to avoid huge requests.
- HEIC/HEIF image analysis via OpenAI may be less reliable than JPG/PNG depending on your workflow. If needed, convert photos to JPG in your phone/cloud export settings.
- No direct Etsy publish action is included on purpose; this app creates **drafts only** for your final review.

## Suggested next upgrades

- Auto-resize/convert images (HEIC → JPG) before AI / Etsy upload
- Saved item templates (mugs, stemware, tumblers)
- Draft queue and batch mode
- Barcode/label printing and SKU generation
- Local database (SQLite) + search
- Direct integration with your own website platform as a second destination

## Security notes

- This is a local app and stores Etsy tokens in `data/etsy_tokens.json` on your machine.
- Keep your `.env` file private.
- Do not expose this app publicly without adding authentication and stronger secret storage.
