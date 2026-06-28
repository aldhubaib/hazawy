# Hazawy · Consistency Lab (local admin)

A local tool to test kid-photo **character consistency**. Create a story, upload its
scene images, upload a child's photo, and regenerate every scene with that child via
**fal.ai** (`fal-ai/nano-banana-2/edit`). Results show side-by-side with the originals.

> This is the **fal-only** build. The AI consistency checker is stubbed — add a free
> `GEMINI_API_KEY` later and implement `server/checker.js` to enable automatic scoring.

## Setup

```bash
cd admin
npm run setup                      # installs server + web deps
cp server/.env.example server/.env # then paste your FAL_KEY into it
```

Get a fal key at https://fal.ai/dashboard/keys.

## User access (Clerk)

Sign-in and per-page permissions are powered by [Clerk](https://dashboard.clerk.com).

```bash
cp web/.env.example web/.env.local   # add VITE_CLERK_PUBLISHABLE_KEY
# add CLERK_SECRET_KEY (and optional ADMIN_EMAILS) to server/.env
```

- **Without** Clerk keys the app runs open (no login, everyone is an admin) — handy for solo local use.
- **With** keys, users must sign in. The first person to sign in (or anyone in `ADMIN_EMAILS`) becomes an admin.
- Admins get an **Access** page in the sidebar to invite people by email and toggle which
  pages (Stories, Orders, Variables) each member can open. `Settings` and `Access` are admin-only.
- Permissions are enforced on the server, not just hidden in the UI.

## Run

```bash
npm run dev
```

- Web UI: http://localhost:5174
- API:    http://localhost:3001

## How it works

1. **Create a story** (sidebar) and **upload scene images**.
2. **Upload the kid's photo** — it's pushed to fal storage once and reused.
3. **Generate all scenes** — each scene + the kid photo are sent to
   `fal-ai/nano-banana-2/edit` with a swap instruction (editable under "advanced").
4. Results are downloaded into `server/uploads/` and shown next to the originals.

Data lives in `server/data/stories.json`; images in `server/uploads/`.

## Enabling the AI checker later

1. Get a free key: https://aistudio.google.com/apikey
2. Put `GEMINI_API_KEY=...` in `server/.env`.
3. Implement the Gemini call in `server/checker.js` (return
   `{ same_child, score, mismatches[] }`). The UI already renders it.
