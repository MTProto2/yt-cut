# yt-cut

Telegram Mini App на React + TelegramUI для нарезки отрывков из YouTube. Это **чисто фронтенд**-репозиторий: своего бэкенда тут больше нет. За доступ к видео и HLS отвечает внешний сервис [yt-hls](https://github.com/mixartemev/yt-hls) (приватный репозиторий, сюда не вендорится) — Mini App ходит в него напрямую из браузера. Единственное, что фронтенд принципиально не может сделать сам (подготовить Telegram inline-сообщение для шаринга — для этого нужен токен бота на сервере), описано как задача в [BACKEND_TASK.md](./BACKEND_TASK.md).

Старый Python-бэкенд (aiohttp + aiogram + yt-dlp + ffmpeg) вырезан целиком: `yt-dlp -g` перестал резолвить прямые ссылки на поток, YouTube отдаёт только SABR для VOD — вместо починки этого куска весь бэкенд заменяется на yt-hls.

## Возможности

- Mini App `/miniapp/`: ввод ссылки → превью (превью и заголовок — из `yt-hls`) → двусторонний слайдер обрезки → переключатель видео/аудио → «Поделиться»
  - В Telegram — нативный выбор контакта через `Telegram.WebApp.shareMessage` (нужен бэкенд из `BACKEND_TASK.md`)
  - Вне Telegram — `navigator.share` / копирование ссылки в буфер, без бэкенда

## Запуск (Docker)

`VITE_YT_HLS_URL` (публичный адрес сервиса yt-hls) зашивается в сборку на этапе `docker build`:

```bash
docker build -t yt-cut --build-arg VITE_YT_HLS_URL=https://yt-hls.example.com .
docker run -p 8080:8080 yt-cut
```

## Локальная разработка

```bash
cd miniapp
npm install
cp .env.example .env   # выставить VITE_YT_HLS_URL
npm run dev            # http://localhost:5173/miniapp/
```

Продакшен-сборка: `cd miniapp && npm run build` → `miniapp/dist/`.

## Требования

- Node 20 + npm — единственная зависимость, Python в репозитории больше нет
- Публично доступный (HTTPS для боевого Mini App) инстанс [yt-hls](https://github.com/mixartemev/yt-hls); CORS там уже открыт (`Access-Control-Allow-Origin: *`)
- Бэкенд для `/api/share` — пока не существует, см. [BACKEND_TASK.md](./BACKEND_TASK.md)
