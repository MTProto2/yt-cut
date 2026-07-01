# Задача для бэкенда

Этот репозиторий — чистый фронтенд (Telegram Mini App, React). Всё, что касается доступа к YouTube/HLS, идёт напрямую из браузера в `yt-hls` (см. `CLAUDE.md`). Но одну вещь фронтенд принципиально не может сделать сам: подготовить Telegram inline-сообщение для нативного шаринга — для этого нужен токен бота, а его нельзя держать в браузере.

Раньше это всё делал Python-бэкенд (`bot.py`, aiohttp + aiogram), его вырезали. **Цель этой задачи — вернуть шаринг ровно как было: нажатие «Поделиться» → нативный chat-picker Telegram → в чат уходит сообщение-ссылка с крупной превьюхой (картинка + проигрываемое видео).** Ниже — что для этого нужно и рабочие куски старого кода как референс.

Важный факт про превью (из-за него мало просто дёрнуть Bot API): Telegram рисует превью, **скачивая URL из сообщения и читая OG-мета-теги**. Старый `bot.py` отдавал эти OG-теги сам — по clip-ссылке, когда на неё заходил краулер `TelegramBot`. Сейчас clip-ссылка ведёт в `yt-hls`, а он отдаёт только `.m3u8`/сегменты, без OG. **Поэтому просто вставить в сообщение сырую `.m3u8`-ссылку → превью не будет.** Нужны обе половины: п.1 (prepared message) **и** п.2 (страница с OG-тегами, на которую этот message ссылается).

---

## 1. `POST /api/share` — подготовка inline-сообщения

Miniapp (`miniapp/src/App.tsx`, функция `onShare`) при нажатии на Telegram `MainButton` шлёт:

```json
POST /api/share
Content-Type: application/json

{
  "init_data": "<строка из Telegram.WebApp.initData>",
  "title": "заголовок, который ввёл пользователь (или оригинальный, если не менял)",
  "original_title": "оригинальное название видео на YouTube",
  "clip_url": "https://clip.xync.net/hls/<video_id>/index.m3u8?from=10&to=60",
  "source_url": "https://www.youtube.com/watch?v=<video_id>",
  "thumbnail": "https://img.youtube.com/vi/<video_id>/maxresdefault.jpg"
}
```

Ожидаемый ответ:

```json
200 OK
{ "prepared_message_id": "..." }
```

или при ошибке `4xx/5xx` → `{ "error": "человеко-читаемое сообщение" }`.

`prepared_message_id` идёт напрямую в `Telegram.WebApp.shareMessage(prepared_message_id)` на фронте — это готовый contract Bot API, менять фронт не нужно.

### Что должен делать хендлер

**1. Проверить `init_data`** — подпись Telegram, доказывающая, что запрос пришёл из Mini App этого пользователя ([офиц. дока](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)). Рабочий код из `bot.py` (проверен в проде, портировать на нужный язык):

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

Нет валидного `user.id` → `401`.

**2. Построить `preview_url`** — ссылку **на свой origin** (эндпоинт из п.2), а не на сырой `.m3u8`. Именно она пойдёт и в текст сообщения, и в `link_preview_options.url`. Как закодировать в неё `clip_url`/`title`/`thumbnail`/`source_url` — на усмотрение бэкенда: query-параметры (`/c?u=<clip_url>&t=<title>&img=<thumb>&src=<source_url>`) или короткий id с сохранением в KV/БД. Второе аккуратнее (URL короче, ничего не подделать).

**3. Собрать текст сообщения** (Markdown, `parse_mode=Markdown`), ссылаясь на `preview_url`:

```
[{title}]({preview_url})

оригинал: [{original_title}]({source_url})
```

**4. Вызвать Bot API `savePreparedInlineMessage`** (в aiogram — `bot.save_prepared_inline_message`). Референс из `bot.py` (адаптирован: ссылки ведут на `preview_url`):

```python
inline_result = InlineQueryResultArticle(
    id=secrets.token_hex(8),
    title=title,
    thumbnail_url=thumbnail,                          # img.youtube.com/vi/<id>/maxresdefault.jpg
    input_message_content=InputTextMessageContent(
        message_text=f"[{title}]({preview_url})\n\nоригинал: [{original_title}]({source_url})",
        parse_mode="Markdown",
        link_preview_options=LinkPreviewOptions(url=preview_url, prefer_large_media=True),
    ),
)

prepared = await bot.save_prepared_inline_message(
    user_id=user["id"],
    result=inline_result,
    allow_user_chats=True,
    allow_group_chats=True,
    allow_channel_chats=True,
)
return {"prepared_message_id": prepared.id}
```

---

## 2. Страница-превью с OG-тегами — это и есть «превьюха»

Эндпоинт (напр. `GET /c/<id>` или `/c?u=…`), на который ссылается сообщение из п.1. Отдаёт маленький HTML с OG-мета-тегами — Telegram по ним рисует крупную картинку + проигрываемое видео. **Без этого превью не будет вообще** (сырой `.m3u8` от `yt-hls` краулер превратить в превью не может).

Точно те же теги, что отдавал старый `bot.py` (`handle_stream`, ветка `if "TelegramBot" in ua`) — только `og:video` теперь указывает на `yt-hls`-стрим (`clip_url`), а не на себя:

```python
html = (
    f'<meta property="og:type" content="video.other">'
    f'<meta property="og:image" content="{thumbnail}">'
    f'<meta property="og:image:width" content="1280">'
    f'<meta property="og:image:height" content="720">'
    f'<meta property="og:title" content="{title}">'
    f'<meta property="og:video" content="{clip_url}">'
    f'<meta property="og:video:type" content="application/vnd.apple.mpegurl">'
    f'<meta name="twitter:card" content="summary_large_image">'
    f'<meta name="twitter:image" content="{thumbnail}">'
)
# Content-Type: text/html
```

- **Экранируй** значения (`title` и т.п.) в HTML-атрибутах — придёт пользовательский ввод.
- **Для живого клика** (не краулер, а человек открыл ссылку из чата): отдай на той же странице редирект/плеер на `clip_url`. Нюанс: `.m3u8` играет нативно только в Safari; для остального лучше редиректить в miniapp или на плеер. Как минимум — `<video>`/ссылка на `clip_url`.
- **Возможное улучшение против «как было»:** у `yt-hls` теперь есть `/dl/<id>` (готовый `.mp4`-файл, см. его README). Если в `og:video` подставить `.mp4` вместо HLS (`og:video:type=video/mp4`), Telegram надёжнее проигрывает превью инлайн во всех клиентах. HLS-вариант оставлен для соответствия старому поведению — выбирай по факту тестов в реальном чате.

---

## 3. Прочее

- Нужен **`BOT_TOKEN`** (тот же бот, что выставляет Mini App). Старый `bot.py` заодно вешал кнопку меню на Mini App через `set_chat_menu_button(MenuButtonWebApp(url=".../miniapp/"))` — если бот должен открывать Mini App кнопкой меню, это тоже нужно куда-то перенести (теперь фронт живёт на `https://yt.xync.net`).
- **Где живёт.** Для фронтенда это просто `POST /api/share` на своём origin (см. `vite.config.ts` — дев-прокси `/api → localhost:8080`). В проде фронт на GitHub Pages (`yt.xync.net`), у которого своего бэкенда нет, поэтому `/api/share` и `/c/...` должны отдаваться с домена, куда реально ходит запрос — либо через реверс-прокси перед Pages, либо фронт нужно поднять там же, где бэкенд. **Это открытый архитектурный вопрос**: сейчас `onShare` бьёт в относительный `/api/share`, т.е. в `yt.xync.net/api/share`, где ничего нет. Варианты: (а) поставить бэкенд за тем же доменом/прокси; (б) захардкодить абсолютный URL бэкенда во фронт (доп. env). Согласуй с владельцем фронта, какой путь берём.

## 4. Замечания по `yt-hls` (не про этот бэкенд, но всплывут)

- **Публичный HTTPS.** Telegram Mini App в WebView требует HTTPS на все запросы. `yt-hls` за TLS-прокси доступен как `https://clip.xync.net`.
- **CORS уже открыт** (`Access-Control-Allow-Origin: *`) — фронт ходит в `yt-hls` напрямую из браузера.
- **`GET /play/<id>` — тяжёлый вызов.** Miniapp дёргает его на каждый дебаунсенный ввод ссылки только ради title/duration, а он стартует полноценную сессию (качает видео в фоне). Если станет проблемой — нужен дешёвый metadata-only endpoint на стороне `yt-hls`.
