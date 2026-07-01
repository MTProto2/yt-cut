# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YouTube Clip Retranslator — a single-process service combining an aiohttp HLS server and a Telegram bot (aiogram). Generates HLS streams from YouTube videos via yt-dlp + ffmpeg and lets users share streaming links through Telegram.

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
- **pip packages:** aiogram ≥ 3.13 (includes aiohttp; needs `save_prepared_inline_message`, Bot API 8.0+), python-dotenv
- **System tools (must be on PATH):** `yt-dlp`, `ffmpeg`
- **Mini App build:** Node 20 + npm (only when building `miniapp/`; the Dockerfile handles it in a multi-stage build)

## .env

- `BOT_TOKEN` — from @BotFather (required)
- `SERVICE_URL` — public base URL for clip links and the Mini App (default: `http://localhost:8080`; must be HTTPS for Telegram Mini App in production)
- `PORT` — HTTP server port (default: `8080`)

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
- `POST /api/info` — body `{url}` → `{video_id, title, duration, thumbnail}` (via `yt-dlp --print`, cached 30 min)
- `POST /api/share` — body `{init_data, video_id, start, end, title, kind}`. Verifies Telegram WebApp `initData` HMAC, then calls `bot.save_prepared_inline_message` with an `InlineQueryResultArticle` pointing at the clip URL. Returns `{prepared_message_id}` for the Mini App to feed into `Telegram.WebApp.shareMessage`.

## Telegram Bot

aiogram 3.x bot with two entry points:

1. **Mini App** (preferred): on startup the bot calls `set_chat_menu_button` with `MenuButtonWebApp` pointing at `{SERVICE_URL}/miniapp/`. Users tap the menu button, fill the form, and share via the native `shareMessage` dialog.
2. **FSM conversation flow** (fallback / classic):
   1. User sends a YouTube URL
   2. Bot asks for start time (min:sec or 0), end time (min:sec or 0 for no trim), and clip title
   3. Bot generates a clip URL with link preview and an inline share button (`https://t.me/share/url?url=...`)

## Architecture

`bot.py` runs an aiohttp server and the aiogram polling loop in a single asyncio process.

**aiohttp server**:
- `_resolve(video_id, kind)` — resolves direct stream URL via `yt-dlp -g`, cached 30 min per `(video_id, kind)`. `kind` is `video` or `audio` (different `-f` selectors)
- `_generate_hls(video_id, start, end, kind)` — runs ffmpeg to generate HLS segments (4s each) in a temp dir, cached 30 min. Audio mode adds `-vn`
- `_fetch_meta(video_id)` — runs `yt-dlp --print` to fetch title + duration for the Mini App, cached 30 min
- `_verify_init_data(init_data)` — validates Telegram WebApp HMAC and returns the user dict
- `handle_stream()` / `handle_ts()` — branch on URL prefix (`/audio/` vs root, `/ts/audio/` vs `/ts/`) to pick `kind`
- `handle_api_info()` / `handle_api_share()` — Mini App endpoints
- `handle_miniapp_index()` + static — serves `miniapp/dist/`

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
