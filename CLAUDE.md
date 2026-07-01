# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YouTube Clip Retranslator — a single-process service combining an aiohttp HLS server and a Telegram bot (aiogram). Generates HLS streams from YouTube videos via a vendored `yt-hls` Node sidecar (SABR access + ffmpeg repackaging) and lets users share streaming links through Telegram.

## Running

```bash
docker build -t yt-cut .
docker run --env-file .env -p 8080:8080 yt-cut
```

Dev (without Docker):
```bash
source venv/bin/activate
python bot.py
```

## Dependencies

- **Python 3.14**
- **pip packages:** aiogram ≥ 3.13 (includes aiohttp; needs `save_prepared_inline_message`, Bot API 8.0+), python-dotenv, curl_cffi (used by `yt-hls/pr_fetch.py`, invoked with `sys.executable`)
- **System tools (must be on PATH):** `node` (≥ 20), `ffmpeg`/`ffprobe`
- **`yt-hls/` npm deps:** `npm install` in `yt-hls/` (triggers a `postinstall` patch of `googlevideo`); the Dockerfile does this in the runtime stage
- **Mini App build:** Node 20 + npm (only when building `miniapp/`; the Dockerfile handles it in a multi-stage build)

## .env

- `BOT_TOKEN` — from @BotFather (required)
- `SERVICE_URL` — public base URL for clip links and the Mini App (default: `http://localhost:8080`; must be HTTPS for Telegram Mini App in production)
- `PORT` — HTTP server port (default: `8080`)
- `PRX` — optional HTTPS proxy, passed to the `yt-hls` sidecar as `HTTPS_PROXY` (bot-wall bypass rotation)
- `TGPRX` — optional proxy for the Telegram Bot API session
- `YT_HLS_PORT` — loopback port for the `yt-hls` sidecar (default: `8730`)

## API

Clip streaming:
- `GET /{video_id}/{start}` — HLS playlist (M3U8), video, plays from `start` seconds to end
- `GET /{video_id}/{start}/{end}` — HLS playlist (M3U8), video, `start` to `end`
- `GET /audio/{video_id}/{start}[/{end}]` — HLS playlist, audio-only (`-vn`, copies audio track)
- `GET /ts/{video_id}/{start}[/{end}]?seg=N` — individual TS segment from cached video HLS
- `GET /ts/audio/{video_id}/{start}[/{end}]?seg=N` — individual TS segment from cached audio HLS

When requested by TelegramBot (User-Agent), the video stream endpoint returns HTML with OG meta tags (thumbnail + title) for link previews. The audio endpoint always returns the playlist.

Mini App:
- `GET /miniapp/` — serves the React SPA from `miniapp/dist/`
- `POST /api/info` — body `{url}` → `{video_id, title, duration, thumbnail}` (via the `yt-hls` sidecar's `/play/<id>`, cached 30 min)
- `POST /api/share` — body `{init_data, video_id, start, end, title, kind}`. Verifies Telegram WebApp `initData` HMAC, then calls `bot.save_prepared_inline_message` with an `InlineQueryResultArticle` pointing at the clip URL. Returns `{prepared_message_id}` for the Mini App to feed into `Telegram.WebApp.shareMessage`.

## Telegram Bot

aiogram 3.x bot with two entry points:

1. **Mini App** (preferred): on startup the bot calls `set_chat_menu_button` with `MenuButtonWebApp` pointing at `{SERVICE_URL}/miniapp/`. Users tap the menu button, fill the form, and share via the native `shareMessage` dialog.
2. **FSM conversation flow** (fallback / classic):
   1. User sends a YouTube URL
   2. Bot asks for start time (min:sec or 0), end time (min:sec or 0 for no trim), and clip title
   3. Bot generates a clip URL with link preview and an inline share button (`https://t.me/share/url?url=...`)

## Architecture

`bot.py` runs an aiohttp server and the aiogram polling loop in a single asyncio process. On startup it also spawns `yt-hls/server.mjs` as a Node subprocess (`_start_yt_hls()`), bound to `127.0.0.1:{YT_HLS_PORT}`, and waits for its `/healthz`. `bot.py` itself never touches YouTube directly — it's a thin reverse proxy in front of the sidecar that preserves yt-cut's public URL scheme (`/{video_id}/{start}/{end}`, `/ts/...?seg=N`) while the sidecar's own scheme (`/hls/<id>/index.m3u8?from=&to=`, `/hls/<id>/segNNNNN.ts`) stays internal.

**aiohttp server**:
- `_start_yt_hls()` / `_stop_yt_hls()` — subprocess lifecycle for the `yt-hls` sidecar
- `_sidecar_query(start, end, kind)` — builds the sidecar's `from`/`to`/`x=1` query from yt-cut's route params (untrimmed `start=0, end=0` omits `from`/`to` entirely, hitting the sidecar's growing/live session instead of its VOD-trim path)
- `_fetch_playlist(video_id, start, end, kind)` — proxies `GET /hls/<id>/index.m3u8` on the sidecar
- `_fetch_meta(video_id)` — proxies `GET /play/<id>` (JSON) on the sidecar for title + duration, cached 30 min
- `_verify_init_data(init_data)` — validates Telegram WebApp HMAC and returns the user dict
- `handle_stream()` / `handle_ts()` — branch on URL prefix (`/audio/` vs root, `/ts/audio/` vs `/ts/`) to pick `kind`; `handle_stream` rewrites the sidecar's `segNNNNN.ts` URIs into yt-cut's `?seg=N` scheme, `handle_ts` reverses that and streams the segment bytes back
- `handle_api_info()` / `handle_api_share()` — Mini App endpoints
- `handle_miniapp_index()` + static — serves `miniapp/dist/`

## `yt-hls/` sidecar

Vendored from `mixartemev/yt-hls` (private repo) — a Node server that fetches YouTube's SABR stream (bypassing the bot-wall that broke plain `yt-dlp -g` resolution) and repackages it to HLS via ffmpeg. See `yt-hls/README.md` for the full design (PO Token minting, keyframe-exact smart-cut trimming, VP9/audio-only modes). yt-cut only ever calls it without `vp9=1`, so segments are always mpegts `.ts` — `x=1` selects audio-only. `pr_fetch.py` (the bot-wall bypass) runs under `sys.executable` (no separate venv) and needs `curl_cffi`.

**aiogram bot**:
- `ClipForm` FSM — states: start → end → title (legacy text flow)
- `parse_time()` — converts "min:sec" or "0" to seconds
- On startup: `set_chat_menu_button(MenuButtonWebApp(...))` to expose the Mini App

## Mini App (`miniapp/`)

Vite + React + TypeScript + `@telegram-apps/telegram-ui` (used as-is, no extra styling).

- `src/App.tsx` — single screen:
  1. `<Input>` for the YouTube link; debounced 500ms `POST /api/info` populates the preview (`<Image>` thumbnail + title in a `<Cell>`)
  2. `<Slider multiple>` (dual-handle range) for `[start, end]`, `min=0`, `max=duration`
  3. `<Switch>` for video/audio mode
  4. Telegram `MainButton` "Поделиться" → `POST /api/share` → `Telegram.WebApp.shareMessage(prepared_message_id)` (native chat picker)
- `vite.config.ts` — `base: '/miniapp/'`, dev proxy `/api → localhost:8080`

Dev: `cd miniapp && npm install && npm run dev` (Mini App at `http://localhost:5173/miniapp/`, backend on `:8080`).
Build: `npm run build` → `miniapp/dist/`. Docker does this automatically in the `miniapp` build stage.
