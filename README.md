# yt-cut

YouTube Clip Retranslator — Telegram-бот + HLS-сервер для нарезки отрывков из YouTube. Включает Mini App на React + TelegramUI.

## Возможности

- Видео-HLS: `GET /{video_id}/{start}[/{end}]`
- Аудио-HLS (только звуковая дорожка): `GET /audio/{video_id}/{start}[/{end}]`
- Mini App `/miniapp/`: ввод ссылки → превью → двусторонний слайдер обрезки → переключатель видео/аудио → MainButton «Поделиться» (нативный выбор контакта через `Telegram.WebApp.shareMessage`)
- Классический FSM-флоу в боте остаётся как fallback

## Запуск (Docker)

Dockerfile двухстадийный: Node собирает Mini App, Python-стадия копирует `dist`.

```bash
docker build -t yt-cut .
docker run --env-file .env -p 8080:8080 -v ./bot.py:/app/bot.py -v ./cookies.txt:/app/cookies.txt yt-cut
```

## Локальная разработка

Бэкенд:
```bash
source venv/bin/activate
python bot.py
```

Mini App (Vite, проксирует `/api` на `localhost:8080`):
```bash
cd miniapp
npm install
npm run dev
```

Production-сборка фронта: `cd miniapp && npm run build` → `miniapp/dist/`.

## .env
```
BOT_TOKEN=<токен от @BotFather>
SERVICE_URL=https://<публичный HTTPS хост>   # обязательный HTTPS для Telegram Mini App
PORT=8080
```

## Требования

- Python 3.14, `aiogram >= 3.13` (нужен `save_prepared_inline_message`, Bot API 8.0+)
- Системные: `yt-dlp`, `ffmpeg` в `PATH`
- Для сборки Mini App: Node 20 + npm (только локально; в Docker это делается автоматически)
