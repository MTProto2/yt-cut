# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YouTube Clip Retranslator — a Telegram Mini App (React SPA) for cutting clips out of YouTube videos. This repo is **frontend-only**: it has no backend of its own. It talks directly to an external `yt-hls` service (https://github.com/mixartemev/yt-hls — private repo) for video metadata and HLS streaming, and to a separate (not-yet-built) small backend for the one thing the browser can't do itself: creating the Telegram "prepared inline message" used by the native share flow. That gap is written up in `BACKEND_TASK.md`.

There used to be a Python (aiohttp + aiogram) backend here that ran `yt-dlp`/`ffmpeg` itself. It was removed because `yt-dlp -g` stopped resolving playable stream URLs (YouTube now only serves SABR for VOD, which `yt-dlp -g` can't speak) — `yt-hls` is the replacement, and it lives in its own repo, not vendored here.

## Running

```bash
docker build -t yt-cut .
docker run -p 8080:8080 yt-cut
```

`VITE_YT_HLS_URL` (the public base URL of the `yt-hls` service) must be set at **build time** (Vite inlines it into the bundle):

```bash
docker build -t yt-cut --build-arg VITE_YT_HLS_URL=https://yt-hls.example.com .
```

Dev (without Docker):
```bash
cd miniapp
npm install
cp .env.example .env   # set VITE_YT_HLS_URL
npm run dev             # http://localhost:5173/miniapp/
```

## Dependencies

- **Node 20 + npm** — the only runtime/build dependency; there is no Python in this repo anymore
- **Frontend:** Vite + React + TypeScript + `@telegram-apps/telegram-ui`
- **Docker runtime image:** `nginx:alpine`, serving the static build from `/usr/share/nginx/html/miniapp`

## Env

- `VITE_YT_HLS_URL` — public base URL of the `yt-hls` service (`miniapp/.env`, or `--build-arg` in Docker). Must be reachable directly from the browser; `yt-hls` already sends `Access-Control-Allow-Origin: *`, so no proxy is needed. For a real Telegram Mini App this must be HTTPS.

## Architecture

`miniapp/src/App.tsx` is the entire app — one screen, no routing, no state library.

1. User pastes a YouTube link → regex-extract the 11-char video id client-side (`VIDEO_ID_RE`)
2. Debounced (500ms) `GET {VITE_YT_HLS_URL}/play/{id}` (`Accept: application/json`) → `{title, durationMs, ...}`. Thumbnail is always `https://img.youtube.com/vi/{id}/maxresdefault.jpg` (no backend needed for that). **Note:** this call starts a `yt-hls` session (it begins pulling the video) even though the miniapp only wants title/duration for the preview — see `BACKEND_TASK.md`.
3. `<Slider multiple>` picks `[start, end]` in seconds, bounded by `duration`
4. `clipStreamUrl(videoId, start, end, audio)` builds the actual clip URL client-side, mirroring `yt-hls`'s own query scheme (`server.mjs`'s `parseTrim`/`sessionQuery`): `{VITE_YT_HLS_URL}/hls/{id}/index.m3u8[?from=&to=][&x=1]`. yt-cut never passes `vp9=1`, so segments are always mpegts `.ts`; `x=1` selects audio-only.
5. Share:
   - **In Telegram** (`tg.initData` present): `MainButton` → `POST /api/share` (relative — same-origin, backend TBD, see `BACKEND_TASK.md`) with `{init_data, title, original_title, clip_url, source_url, thumbnail}` → `{prepared_message_id}` → `tg.shareMessage(...)` (native chat picker)
   - **Outside Telegram** (plain browser): a fixed bottom button uses `navigator.share`, falling back to clipboard-copy, with the same client-built `clip_url` — no backend involved at all

## Mini App (`miniapp/`)

- `src/App.tsx` — see Architecture above
- `src/vite-env.d.ts` — typing for `import.meta.env.VITE_YT_HLS_URL`
- `vite.config.ts` — `base: '/miniapp/'`; dev proxy `/api → localhost:8080` (placeholder for whatever implements `BACKEND_TASK.md` locally)
- `nginx.conf` (repo root) — redirects `/` → `/miniapp/`, SPA fallback for `/miniapp/*`

Build: `npm run build` → `miniapp/dist/`. Docker does this in the `build` stage and serves it via nginx.

## `BACKEND_TASK.md`

Spec for the one feature this repo can't implement itself (Telegram share requires the bot token server-side). Read it before assuming a `/api/share` backend exists anywhere — it doesn't yet.
