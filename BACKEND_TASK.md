# Задача для бэкенда

Этот репозиторий — чистый фронтенд (Telegram Mini App, React). Всё, что касается доступа к YouTube/HLS, идёт напрямую из браузера в `yt-hls` (см. `CLAUDE.md`). Но одну вещь фронтенд принципиально не может сделать сам: подготовить Telegram inline-сообщение для нативного шаринга — для этого нужен токен бота, а его нельзя держать в браузере. Это и есть задача ниже.

## 1. `POST /api/share` — подготовка inline-сообщения для шаринга

Miniapp (`miniapp/src/App.tsx`, функция `onShare`) при нажатии на Telegram `MainButton` шлёт:

```json
POST /api/share
Content-Type: application/json

{
  "init_data": "<строка из Telegram.WebApp.initData>",
  "title": "заголовок, который ввёл пользователь (или оригинальный, если не менял)",
  "original_title": "оригинальное название видео на YouTube",
  "clip_url": "https://yt-hls.example.com/hls/<video_id>/index.m3u8?from=10&to=60",
  "source_url": "https://www.youtube.com/watch?v=<video_id>",
  "thumbnail": "https://img.youtube.com/vi/<video_id>/maxresdefault.jpg"
}
```

Ожидаемый ответ:

```json
200 OK
{ "prepared_message_id": "..." }
```

или при ошибке:

```json
4xx/5xx
{ "error": "человеко-читаемое сообщение" }
```

`prepared_message_id` идёт напрямую в `Telegram.WebApp.shareMessage(prepared_message_id)` на фронте — это готовый contract Bot API, ничего от бэкенда сверху не требуется.

### Что должен делать хендлер

1. **Проверить `init_data`** — это подпись Telegram, доказывающая, что запрос действительно пришёл из открытого этим пользователем Mini App, а не подделан. Алгоритм (см. [офиц. доку](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)):
   - распарсить `init_data` как query-string;
   - вытащить и убрать поле `hash`;
   - оставшиеся пары `key=value` отсортировать по ключу и склеить через `\n` в `data_check_string`;
   - `secret_key = HMAC_SHA256(key="WebAppData", data=<BOT_TOKEN>)`;
   - `expected_hash = HMAC_SHA256(key=secret_key, data=data_check_string)` (hex);
   - сравнить с `hash` из `init_data` (constant-time compare);
   - если не совпало — 401.

   Референс (рабочий Python-код из старого `bot.py`, был проверен в проде — просто портировать на нужный язык):

   ```python
   def _verify_init_data(init_data: str) -> dict | None:
       parsed = dict(parse_qsl(init_data, strict_parsing=True))
       recv_hash = parsed.pop("hash", None)
       if not recv_hash:
           return None
       data_check = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
       secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
       calc = hmac.new(secret, data_check.encode(), hashlib.sha256).hexdigest()
       if not hmac.compare_digest(calc, recv_hash):
           return None
       return json.loads(parsed.get("user", "{}"))  # {"id": ..., ...}
   ```

2. **Собрать текст сообщения**, например:
   ```
   [{title}]({clip_url})

   оригинал: [{original_title}]({source_url})
   ```
   (Markdown, `parse_mode=Markdown`)

3. **Вызвать Bot API** `savePreparedInlineMessage` (в aiogram — `bot.save_prepared_inline_message`) с `InlineQueryResultArticle`:
   - `user_id` — `id` из `user`, полученного на шаге 1;
   - `result` — `InlineQueryResultArticle(thumbnail_url=thumbnail, title=title, input_message_content=InputTextMessageContent(message_text=..., parse_mode="Markdown", link_preview_options=LinkPreviewOptions(url=clip_url, prefer_large_media=True)))`;
   - `allow_user_chats=True, allow_group_chats=True, allow_channel_chats=True`;
   - вернуть `{"prepared_message_id": prepared.id}`.

Нужен `BOT_TOKEN` (тот же бот, что выставляет Mini App через `set_chat_menu_button` — это тоже раньше делал `bot.py`, теперь тоже нужно куда-то перенести, если бот вообще должен уметь открывать Mini App через кнопку меню).

### Где это должно жить

Неважно, для фронтенда это просто `POST /api/share` на своём origin (см. `vite.config.ts` — дев-прокси `/api → localhost:8080`, поменяйте порт под себя). Может быть отдельным сервисом за тем же реверс-прокси, что раздаёт статику фронтенда.

## 2. Замечания по `yt-hls`, не про этот репозиторий, но всплывут

- **Нужен публичный HTTPS.** Сейчас `yt-hls` слушает голый HTTP и по умолчанию только `127.0.0.1`. Telegram Mini App выполняется в WebView с требованием HTTPS для всех запросов — просто `HOST=0.0.0.0` не хватит, нужен TLS-терминирующий реверс-прокси перед ним.
- **CORS уже открыт** (`Access-Control-Allow-Origin: *` на всех ответах) — фронтенд ходит в `yt-hls` напрямую из браузера, прокси на этот случай не нужен.
- **`GET /play/<id>` — тяжёлый вызов.** Miniapp дёргает его на каждый дебаунсенный ввод ссылки просто чтобы получить title/duration для превью, а он при этом стартует полноценную `yt-hls`-сессию (качает видео в фоне). Работает, но дорого гонять при каждом наборе ссылки/правке диапазона. Если это станет проблемой — стоит завести отдельный дешёвый endpoint только для метаданных (без старта сессии).
- **Нет OG-превью для шаринга.** Старый `bot.py` при заходе Telegram-краулера на клип-ссылку отдавал HTML с `og:title`/`og:image`, чтобы ссылка красиво разворачивалась в чате. `yt-hls` отдаёт только JSON/M3U8/сегменты — такой страницы там нет. Сейчас это заметно только в браузерном fallback-шаринге (`navigator.share`/копирование ссылки, вне Telegram): ссылка будет просто текстом, без превью. Если это важно — нужна отдельная маленькая HTML-страница с OG-тегами (может быть частью того же бэкенда из п.1).
