"""
YouTube Clip Retranslator — Telegram bot + aiohttp clip server.

The actual YouTube access/HLS-repackaging work is done by a vendored
`yt-hls` (https://github.com/mixartemev/yt-hls) Node sidecar, spawned as a
subprocess on startup and reached over loopback HTTP. This file owns the
Telegram bot, the Mini App API, and a thin reverse proxy in front of the
sidecar that keeps the public URL scheme stable.

Env vars:
    BOT_TOKEN    — Telegram bot token from @BotFather
    SERVICE_URL  — public base URL for clip links (e.g. https://example.com)
    PORT         — HTTP server port (default 8080)
    PRX          — HTTPS proxy passed to the yt-hls sidecar (bot-wall bypass)
    TGPRX        — proxy for the Telegram Bot API session
    YT_HLS_PORT  — loopback port for the yt-hls sidecar (default 8730)
"""

import os
import re
import sys
import asyncio
import logging
import time
import tempfile
import hmac
import hashlib
import json
import secrets
from urllib.parse import quote, parse_qsl

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s.%(msecs)03d %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("yt-cut")

from aiogram.client.session.aiohttp import AiohttpSession
from dotenv import load_dotenv

load_dotenv()

from aiohttp import web, ClientSession, ClientTimeout
from aiogram import Bot, Dispatcher, F
from aiogram.types import (
    Message,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    ReplyKeyboardRemove,
    LinkPreviewOptions,
    InlineQueryResultArticle,
    InputTextMessageContent,
    MenuButtonWebApp,
    WebAppInfo,
)
from aiogram.filters import CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup


BOT_TOKEN = os.environ["BOT_TOKEN"]
SERVICE_URL = os.environ.get("SERVICE_URL", "http://127.0.0.1:8080")
PORT = int(os.environ.get("PORT", "8080"))
PRX = os.environ.get("PRX")
TGPRX = os.environ.get("TGPRX")

YT_HLS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "yt-hls")
YT_HLS_PORT = int(os.environ.get("YT_HLS_PORT", "8730"))
YT_HLS_BASE = f"http://127.0.0.1:{YT_HLS_PORT}"

session = TGPRX and AiohttpSession(proxy=TGPRX)
bot = Bot(token=BOT_TOKEN, session=session)
dp = Dispatcher()

VIDEO_ID_RE = re.compile(r"(?:youtu\.be/|youtube\.com/watch\?v=|youtube\.com/embed/)([a-zA-Z0-9_-]{11})")

_CACHE_TTL = 1800

_title_cache: dict[tuple, str] = {}
_meta_cache: dict[str, tuple[dict, float]] = {}

_KIND_PREFIX = {"video": "", "audio": "/audio"}

MINIAPP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "miniapp", "dist")

http_client: ClientSession | None = None
yt_hls_proc: "asyncio.subprocess.Process | None" = None


def _clip_path(v: str, start: int, end: int, kind: str) -> str:
    base = f"{_KIND_PREFIX[kind]}/{v}/{start}"
    return f"{base}/{end}" if end else base


def _ts_path(v: str, start: int, end: int, kind: str) -> str:
    return "/ts" + _clip_path(v, start, end, kind)


# ── yt-hls sidecar ───────────────────────────────────────────────────────────


async def _start_yt_hls():
    """Spawn the vendored yt-hls Node server and wait until it answers /healthz."""
    global yt_hls_proc
    env = os.environ.copy()
    env["HOST"] = "127.0.0.1"
    env["PORT"] = str(YT_HLS_PORT)
    env["YT_HLS_PYTHON"] = sys.executable
    env["YT_HLS_SESSIONS"] = os.path.join(tempfile.gettempdir(), "yt-hls-sessions")
    if PRX:
        env["HTTPS_PROXY"] = PRX

    yt_hls_proc = await asyncio.create_subprocess_exec("node", "server.mjs", cwd=YT_HLS_DIR, env=env)
    log.info("yt-hls sidecar starting (pid=%s)", yt_hls_proc.pid)

    deadline = time.time() + 30
    while time.time() < deadline:
        if yt_hls_proc.returncode is not None:
            raise RuntimeError(f"yt-hls sidecar exited early (code {yt_hls_proc.returncode})")
        try:
            async with http_client.get(f"{YT_HLS_BASE}/healthz", timeout=ClientTimeout(total=2)) as r:
                if r.status == 200:
                    log.info("yt-hls sidecar ready")
                    return
        except Exception:
            pass
        await asyncio.sleep(0.5)
    raise RuntimeError("yt-hls sidecar did not become ready in time")


async def _stop_yt_hls():
    if not yt_hls_proc or yt_hls_proc.returncode is not None:
        return
    yt_hls_proc.terminate()
    try:
        await asyncio.wait_for(yt_hls_proc.wait(), timeout=10)
    except asyncio.TimeoutError:
        yt_hls_proc.kill()
        await yt_hls_proc.wait()


def _sidecar_query(start: int, end: int, kind: str) -> dict:
    q = {}
    if start or end:
        q["from"] = str(start)
        if end:
            q["to"] = str(end)
    if kind == "audio":
        q["x"] = "1"
    return q


async def _fetch_playlist(video_id: str, start: int, end: int, kind: str) -> str:
    q = _sidecar_query(start, end, kind)
    async with http_client.get(
        f"{YT_HLS_BASE}/hls/{video_id}/index.m3u8", params=q, timeout=ClientTimeout(total=900),
    ) as r:
        text = await r.text()
        if r.status != 200:
            raise RuntimeError(text.strip() or f"sidecar status {r.status}")
        return text


# ── Clip server ──────────────────────────────────────────────────────────────


async def _fetch_meta(video_id: str) -> dict:
    now = time.time()
    cached = _meta_cache.get(video_id)
    if cached and now - cached[1] < _CACHE_TTL:
        return cached[0]

    async with http_client.get(
        f"{YT_HLS_BASE}/play/{video_id}",
        headers={"Accept": "application/json"},
        timeout=ClientTimeout(total=120),
    ) as r:
        if r.status != 200:
            raise RuntimeError((await r.text()).strip())
        data = await r.json()

    meta = {
        "video_id": video_id,
        "title": data.get("title") or video_id,
        "duration": int((data.get("durationMs") or 0) / 1000),
        "thumbnail": f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg",
    }
    _meta_cache[video_id] = (meta, now)
    return meta


async def handle_stream(request: web.Request) -> web.Response:
    kind = "audio" if request.path.startswith("/audio/") else "video"
    v = request.match_info["v"]
    start = int(request.match_info["start"])
    end = int(request.match_info.get("end") or 0)
    log.info("stream request: %s start=%s end=%s ua=%s",
             request.path, start, end, request.headers.get("User-Agent", "")[:60])

    if end and end <= start:
        return web.json_response({"error": "end must be greater than start"}, status=400)

    # Telegram link preview bot — return HTML with OG tags (video only)
    ua = request.headers.get("User-Agent", "")
    if kind == "video" and "TelegramBot" in ua:
        thumb = f"https://img.youtube.com/vi/{v}/maxresdefault.jpg"
        title = _title_cache.get((v, start, end), "YouTube Clip")
        self_url = str(request.url)
        html = (
            f'<meta property="og:type" content="video.other">'
            f'<meta property="og:image" content="{thumb}">'
            f'<meta property="og:image:width" content="1280">'
            f'<meta property="og:image:height" content="720">'
            f'<meta property="og:title" content="{title}">'
            f'<meta property="og:video" content="{self_url}">'
            f'<meta property="og:video:type" content="application/vnd.apple.mpegurl">'
            f'<meta name="twitter:card" content="summary_large_image">'
            f'<meta name="twitter:image" content="{thumb}">'
        )
        return web.Response(text=html, content_type="text/html")

    ts_base = SERVICE_URL + _ts_path(v, start, end, kind)

    try:
        m3u8 = await _fetch_playlist(v, start, end, kind)
    except Exception as e:
        log.error("stream: sidecar failed for %s: %s", v, e)
        return web.json_response({"error": str(e)}, status=502)

    m3u8 = re.sub(r"seg(\d+)\.ts(?:\?[^\s]*)?", lambda m: f"{ts_base}?seg={int(m.group(1))}", m3u8)
    return web.Response(text=m3u8, content_type="application/vnd.apple.mpegurl")


async def handle_ts(request: web.Request) -> web.Response:
    kind = "audio" if request.path.startswith("/ts/audio/") else "video"
    v = request.match_info["v"]
    start = int(request.match_info["start"])
    end = int(request.match_info.get("end") or 0)
    seg = request.query.get("seg")

    if seg is None:
        return web.json_response({"error": "Required param: seg"}, status=400)
    try:
        seg_n = int(seg)
    except ValueError:
        return web.json_response({"error": "Invalid seg"}, status=400)

    filename = f"seg{seg_n:05d}.ts"
    q = _sidecar_query(start, end, kind)
    t0 = time.time()
    try:
        async with http_client.get(
            f"{YT_HLS_BASE}/hls/{v}/{filename}", params=q, timeout=ClientTimeout(total=900),
        ) as r:
            if r.status != 200:
                body = (await r.text()).strip()
                log.warning("ts seg=%d: sidecar %d — %s", seg_n, r.status, body)
                status = 404 if r.status == 404 else 502
                return web.json_response({"error": body or "Segment not found"}, status=status)
            data = await r.read()
    except asyncio.TimeoutError:
        log.error("ts seg=%d: sidecar timeout", seg_n)
        return web.json_response({"error": "sidecar timeout"}, status=504)

    log.debug("ts seg=%d size=%d (%.1fs)", seg_n, len(data), time.time() - t0)
    return web.Response(body=data, content_type="video/mp2t")


# ── Mini App API ─────────────────────────────────────────────────────────────


def _verify_init_data(init_data: str) -> dict | None:
    """Validate Telegram WebApp initData HMAC. Returns user dict on success."""
    try:
        parsed = dict(parse_qsl(init_data, strict_parsing=True))
        recv_hash = parsed.pop("hash", None)
        if not recv_hash:
            return None
        data_check = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
        secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        calc = hmac.new(secret, data_check.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calc, recv_hash):
            return None
        return json.loads(parsed.get("user", "{}"))
    except Exception:
        return None


async def handle_api_info(request: web.Request) -> web.Response:
    body = await request.json()
    url = (body.get("url") or "").strip()
    m = VIDEO_ID_RE.search(url)
    if not m:
        return web.json_response({"error": "Invalid YouTube URL"}, status=400)
    try:
        meta = await _fetch_meta(m.group(1))
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)
    return web.json_response(meta)


async def handle_api_share(request: web.Request) -> web.Response:
    body = await request.json()
    user = _verify_init_data(body.get("init_data", ""))
    if not user or "id" not in user:
        return web.json_response({"error": "Auth failed"}, status=401)

    video_id = body["video_id"]
    start = int(body.get("start", 0))
    end = int(body.get("end", 0))
    title = (body.get("title") or "").strip() or "YouTube Clip"
    kind = "audio" if body.get("kind") == "audio" else "video"

    if end and end <= start:
        return web.json_response({"error": "end must be greater than start"}, status=400)

    clip_url = SERVICE_URL + _clip_path(video_id, start, end, kind)
    source_url = f"https://www.youtube.com/watch?v={video_id}"
    _title_cache[(video_id, start, end)] = title

    try:
        original_title = (await _fetch_meta(video_id))["title"]
    except Exception:
        original_title = title

    message_text = f"[{title}]({clip_url})\n\nоригинал: [{original_title}]({source_url})"

    inline_result = InlineQueryResultArticle(
        id=secrets.token_hex(8),
        title=title,
        thumbnail_url=f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg",
        input_message_content=InputTextMessageContent(
            message_text=message_text,
            parse_mode="Markdown",
            link_preview_options=LinkPreviewOptions(url=clip_url, prefer_large_media=True),
        ),
    )

    try:
        prepared = await bot.save_prepared_inline_message(
            user_id=user["id"],
            result=inline_result,
            allow_user_chats=True,
            allow_group_chats=True,
            allow_channel_chats=True,
        )
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)

    return web.json_response({"prepared_message_id": prepared.id})


async def handle_miniapp_index(request: web.Request) -> web.StreamResponse:
    return web.FileResponse(os.path.join(MINIAPP_DIR, "index.html"))


async def handle_miniapp_redirect(request: web.Request) -> web.StreamResponse:
    raise web.HTTPFound("/miniapp/")


# ── Telegram bot ─────────────────────────────────────────────────────────────

class ClipForm(StatesGroup):
    start = State()
    end = State()
    title = State()


def parse_time(text: str) -> int:
    """Parse 'min:sec' (e.g. 8:54) or '0' to seconds."""
    text = text.strip()
    if text == "0":
        return 0
    m = re.fullmatch(r"(\d+):(\d{1,2})", text)
    if not m:
        raise ValueError
    minutes, seconds = int(m.group(1)), int(m.group(2))
    if seconds >= 60:
        raise ValueError
    return minutes * 60 + seconds


@dp.message(CommandStart())
async def cmd_start(message: Message, state: FSMContext):
    await state.clear()
    await message.answer(
        "Привет! Отправь ссылку на YouTube ролик, чтобы создать отрывок.",
        reply_markup=ReplyKeyboardRemove(),
    )


@dp.message(~F.text)
async def ignore_non_text(message: Message):
    pass


@dp.message(ClipForm.start)
async def process_start(message: Message, state: FSMContext):
    try:
        start = parse_time(message.text)
    except ValueError:
        await message.answer("Некорректный формат. Введите время как min:sec (например 8:54):")
        return
    await state.update_data(start=start)
    await state.set_state(ClipForm.end)
    await message.answer("Введите время конца в формате min:sec (например 10:30 или 0, если до конца):")


@dp.message(ClipForm.end)
async def process_end(message: Message, state: FSMContext):
    try:
        end = parse_time(message.text)
    except ValueError:
        await message.answer("Некорректный формат. Введите время как min:sec (например 10:30 или 0):")
        return

    data = await state.get_data()
    start = data["start"]

    if end and end <= start:
        await message.answer("Время конца должно быть больше времени начала. Попробуйте ещё раз:")
        return

    await state.update_data(end=end)
    await state.set_state(ClipForm.title)
    await message.answer("Введите название ролика:")


@dp.message(ClipForm.title)
async def process_title(message: Message, state: FSMContext):
    title = message.text.strip()
    data = await state.get_data()
    await state.clear()

    start, end, v = data["start"], data["end"], data["v"]
    _title_cache[(v, start, end)] = title
    clip_url = SERVICE_URL + _clip_path(v, start, end, "video")
    share_url = f"https://t.me/share/url?url={quote(clip_url)}"

    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Поделиться с контактом", url=share_url)],
        ]
    )
    await message.answer(
        f"[{title}]({clip_url})",
        parse_mode="Markdown",
        link_preview_options=LinkPreviewOptions(prefer_large_media=True),
        reply_markup=kb,
    )


@dp.message()
async def process_url(message: Message, state: FSMContext):
    m = VIDEO_ID_RE.search(message.text.strip())
    if not m:
        await message.answer("Отправьте ссылку на YouTube ролик:")
        return
    await state.update_data(v=m.group(1))
    await state.set_state(ClipForm.start)
    await message.answer("Введите время начала в формате min:sec (например 8:54 или 0, если с самого начала):")


# ── Entrypoint ───────────────────────────────────────────────────────────────


async def handle_root(request: web.Request) -> web.Response:
    me = await bot.get_me()
    raise web.HTTPFound(f"https://t.me/{me.username}")


async def main():
    global http_client
    http_client = ClientSession()

    app = web.Application()
    app.router.add_get("/", handle_root)
    vid = r"{v:[a-zA-Z0-9_-]{11}}"
    for prefix, handler in (
        ("", handle_stream),
        ("/audio", handle_stream),
        ("/ts", handle_ts),
        ("/ts/audio", handle_ts),
    ):
        base = f"{prefix}/{vid}/{{start:\\d+}}"
        app.router.add_get(base, handler)
        app.router.add_get(f"{base}/{{end:\\d+}}", handler)

    app.router.add_post("/api/info", handle_api_info)
    app.router.add_post("/api/share", handle_api_share)

    if os.path.isdir(MINIAPP_DIR):
        app.router.add_get("/miniapp", handle_miniapp_redirect)
        app.router.add_get("/miniapp/", handle_miniapp_index)
        app.router.add_static("/miniapp/", MINIAPP_DIR)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()

    await _start_yt_hls()

    try:
        await bot.set_chat_menu_button(
            menu_button=MenuButtonWebApp(
                text="Редактор",
                web_app=WebAppInfo(url=f"{SERVICE_URL}/miniapp/"),
            )
        )
    except Exception:
        pass

    try:
        await dp.start_polling(bot)
    finally:
        await runner.cleanup()
        await http_client.close()
        await _stop_yt_hls()


if __name__ == "__main__":
    asyncio.run(main())
