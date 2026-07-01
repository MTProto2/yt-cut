"""
YouTube Clip Retranslator — Telegram bot + aiohttp clip server.

Env vars:
    BOT_TOKEN    — Telegram bot token from @BotFather
    SERVICE_URL  — public base URL for clip links (e.g. https://example.com)
    PORT         — HTTP server port (default 8080)
"""

import os
import re
import asyncio
import logging
import time
import tempfile
import shutil
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

from aiohttp import web
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
YT_CLIENT = os.environ.get("YT_CLIENT")
YT_COOKIES = os.environ.get("YT_COOKIES")

_YT_COMMON = []
if PRX:
    _YT_COMMON += ["--proxy", PRX]
if YT_CLIENT:
    _YT_COMMON += ["--extractor-args", f"youtube:player_client={YT_CLIENT}"]
if YT_COOKIES:
    _YT_COMMON += ["--cookies", YT_COOKIES]

session = TGPRX and AiohttpSession(proxy=TGPRX)
bot = Bot(token=BOT_TOKEN, session=session)
dp = Dispatcher()

VIDEO_ID_RE = re.compile(r"(?:youtu\.be/|youtube\.com/watch\?v=|youtube\.com/embed/)([a-zA-Z0-9_-]{11})")

_CACHE_TTL = 1800
_BATCH = 30          # segments per ffmpeg job (30 × 4 s = 2 min)

_url_cache: dict[tuple[str, str], tuple[str, float]] = {}
# (vid, clip_start, clip_end, kind) → {batch_start_seg: (tmpdir, task|None, created_at)}
_hls_batches: dict[tuple, dict[int, tuple[str, "asyncio.Task | None", float]]] = {}
_title_cache: dict[tuple, str] = {}
_meta_cache: dict[str, tuple[dict, float]] = {}

_FORMATS = {
    "video": "best[height<=720][ext=mp4]/best[ext=mp4]/best",
    "audio": "bestaudio[ext=m4a]/bestaudio",
}
_KIND_PREFIX = {"video": "", "audio": "/audio"}

MINIAPP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "miniapp", "dist")


def _clip_path(v: str, start: int, end: int, kind: str) -> str:
    base = f"{_KIND_PREFIX[kind]}/{v}/{start}"
    return f"{base}/{end}" if end else base


def _ts_path(v: str, start: int, end: int, kind: str) -> str:
    return "/ts" + _clip_path(v, start, end, kind)


# ── Clip server ──────────────────────────────────────────────────────────────


async def _resolve(video_id: str, kind: str = "video") -> str:
    now = time.time()
    key = (video_id, kind)
    cached = _url_cache.get(key)
    if cached and now - cached[1] < _CACHE_TTL:
        log.debug("resolve cache hit: %s/%s", video_id, kind)
        return cached[0]

    log.info("resolve start: %s/%s", video_id, kind)
    t0 = time.time()
    proc = await asyncio.create_subprocess_exec(
        "yt-dlp", "-f", _FORMATS[kind], "-g", *_YT_COMMON,
        f"https://www.youtube.com/watch?v={video_id}",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
    if proc.returncode != 0:
        err = stderr.decode().strip()
        log.error("resolve failed (%.1fs): %s/%s — %s", time.time() - t0, video_id, kind, err)
        raise RuntimeError(err)

    url = stdout.decode().strip().splitlines()[0]
    log.info("resolve done (%.1fs): %s/%s", time.time() - t0, video_id, kind)
    _url_cache[key] = (url, now)
    return url


def _cleanup_hls():
    now = time.time()
    for clip_key, batches in list(_hls_batches.items()):
        for bs in [b for b, (_, _, ts) in batches.items() if now - ts > _CACHE_TTL]:
            tmpdir, task, _ = batches.pop(bs)
            if task and not task.done():
                task.cancel()
            shutil.rmtree(tmpdir, ignore_errors=True)
        if not batches:
            del _hls_batches[clip_key]


def _synth_m3u8(ts_base: str, duration: int) -> str:
    """Full VOD playlist for a known-duration clip (no ffmpeg needed yet)."""
    seg_time = 4
    lines = [
        "#EXTM3U", "#EXT-X-VERSION:3",
        f"#EXT-X-TARGETDURATION:{seg_time}", "#EXT-X-MEDIA-SEQUENCE:0",
    ]
    t = i = 0
    while t < duration:
        d = min(seg_time, duration - t)
        lines += [f"#EXTINF:{d:.6f},", f"{ts_base}?seg={i}"]
        t += d; i += 1
    lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


async def _ensure_batch(
    video_id: str, clip_start: int, clip_end: int, kind: str, batch_start: int,
) -> tuple[str, "asyncio.Task | None"]:
    """
    Ensure an ffmpeg job covering segments [batch_start, batch_start+_BATCH) is running.
    Each job writes seg0.ts…segN.ts into its own tmpdir; local_seg = global_seg - batch_start.
    """
    clip_key = (video_id, clip_start, clip_end, kind)
    _cleanup_hls()
    batches = _hls_batches.setdefault(clip_key, {})

    if batch_start in batches:
        tmpdir, task, _ = batches[batch_start]
        return tmpdir, task

    stream_url = await _resolve(video_id, kind)

    # Re-check after yield
    if batch_start in batches:
        tmpdir, task, _ = batches[batch_start]
        return tmpdir, task

    ffmpeg_ss = clip_start + batch_start * 4        # absolute seek position in video
    batch_end_abs = clip_start + (batch_start + _BATCH) * 4
    if clip_end:
        ffmpeg_t = min(clip_end, batch_end_abs) - ffmpeg_ss
        if ffmpeg_t <= 0:
            raise RuntimeError(f"Segment {batch_start} is past clip end")
    else:
        ffmpeg_t = _BATCH * 4

    tmpdir = tempfile.mkdtemp(prefix="hls_")
    cmd = ["ffmpeg", "-ss", str(ffmpeg_ss), "-i", stream_url, "-t", str(ffmpeg_t)]
    if kind == "audio":
        cmd += ["-vn"]
    cmd += [
        "-c", "copy", "-f", "hls", "-hls_time", "4",
        "-hls_playlist_type", "vod",
        "-hls_segment_filename", os.path.join(tmpdir, "seg%d.ts"),
        "-loglevel", "error",
        os.path.join(tmpdir, "stream.m3u8"),
    ]

    log.info("ffmpeg batch start: %s/%s batch=%d (t=%d+%ds) tmpdir=%s",
             video_id, kind, batch_start, ffmpeg_ss, ffmpeg_t, tmpdir)
    t0 = time.time()
    proc = await asyncio.create_subprocess_exec(*cmd, stderr=asyncio.subprocess.PIPE)

    async def _run():
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            batches.pop(batch_start, None)
            shutil.rmtree(tmpdir, ignore_errors=True)
            raise RuntimeError("ffmpeg timeout")
        if proc.returncode != 0:
            err = stderr.decode().strip()
            log.error("ffmpeg batch error (%.1fs): %s batch=%d rc=%d — %s",
                      time.time() - t0, video_id, batch_start, proc.returncode, err)
            batches.pop(batch_start, None)
            shutil.rmtree(tmpdir, ignore_errors=True)
            raise RuntimeError(err or "ffmpeg error")
        log.info("ffmpeg batch done (%.1fs): %s/%s batch=%d",
                 time.time() - t0, video_id, kind, batch_start)
        # mark as complete (task=None keeps the entry alive for TTL cleanup)
        batches[batch_start] = (tmpdir, None, batches[batch_start][2])

    task = asyncio.create_task(_run())
    batches[batch_start] = (tmpdir, task, time.time())
    return tmpdir, task


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

    if end:
        # Duration known → full VOD playlist immediately; batches start on first TS request.
        m3u8 = _synth_m3u8(ts_base, end - start)
        log.info("stream: synthetic m3u8 %d segs", (end - start + 3) // 4)
    else:
        # Duration unknown → must wait for ffmpeg to finish batch 0.
        try:
            tmpdir, task = await _ensure_batch(v, start, end, kind, 0)
            if task is not None:
                await task
            tmpdir, _, _ = _hls_batches[(v, start, end, kind)][0]
        except RuntimeError as e:
            return web.json_response({"error": str(e)}, status=502)
        with open(os.path.join(tmpdir, "stream.m3u8")) as f:
            m3u8 = f.read()
        m3u8 = re.sub(r"seg(\d+)\.ts", lambda m: f"{ts_base}?seg={m.group(1)}", m3u8)
        log.info("stream: m3u8 from disk (end=0)")

    return web.Response(text=m3u8, content_type="application/vnd.apple.mpegurl")


async def handle_ts(request: web.Request) -> web.Response:
    kind = "audio" if request.path.startswith("/ts/audio/") else "video"
    v = request.match_info["v"]
    start = int(request.match_info["start"])
    end = int(request.match_info.get("end") or 0)
    seg = request.query.get("seg")

    if seg is None:
        return web.json_response({"error": "Required param: seg"}, status=400)

    seg_n = int(seg)
    batch_start = (seg_n // _BATCH) * _BATCH
    local_seg = seg_n - batch_start

    log.debug("ts request: seg=%d batch=%d local=%d", seg_n, batch_start, local_seg)
    t0 = time.time()

    try:
        tmpdir, task = await _ensure_batch(v, start, end, kind, batch_start)
    except RuntimeError as e:
        log.error("ts seg=%d: batch start failed: %s", seg_n, e)
        return web.json_response({"error": str(e)}, status=502)

    ts_path = os.path.join(tmpdir, f"seg{local_seg}.ts")
    next_path = os.path.join(tmpdir, f"seg{local_seg + 1}.ts")
    m3u8_path = os.path.join(tmpdir, "stream.m3u8")

    # With VOD mode, ffmpeg closes seg[N] before opening seg[N+1], so seg[N] is
    # fully written when seg[N+1] exists or stream.m3u8 exists (ffmpeg finished).
    for i in range(120):  # up to 60 s
        if os.path.isfile(ts_path):
            if os.path.isfile(next_path) or os.path.isfile(m3u8_path) or task is None or (task is not None and task.done()):
                size = os.path.getsize(ts_path)
                waited = time.time() - t0
                if waited > 0.3:
                    log.info("ts seg=%d ready after %.1fs size=%d", seg_n, waited, size)
                else:
                    log.debug("ts seg=%d size=%d", seg_n, size)
                return web.FileResponse(ts_path, headers={"Content-Type": "video/mp2t"})
        if task is not None and task.done():
            if task.exception():
                log.error("ts seg=%d: ffmpeg failed: %s", seg_n, task.exception())
                return web.json_response({"error": str(task.exception())}, status=502)
            if not os.path.isfile(ts_path):
                log.warning("ts seg=%d: ffmpeg done, file missing", seg_n)
                break
        if i % 10 == 0:
            log.debug("ts seg=%d: waiting... (%.1fs)", seg_n, time.time() - t0)
        await asyncio.sleep(0.5)

    log.error("ts seg=%d: not found after %.1fs", seg_n, time.time() - t0)
    return web.json_response({"error": "Segment not found"}, status=404)


# ── Mini App API ─────────────────────────────────────────────────────────────

async def _fetch_meta(video_id: str) -> dict:
    now = time.time()
    cached = _meta_cache.get(video_id)
    if cached and now - cached[1] < _CACHE_TTL:
        return cached[0]

    proc = await asyncio.create_subprocess_exec(
        "yt-dlp", "--print", "%(title)s\n%(duration)s", *_YT_COMMON,
        f"https://www.youtube.com/watch?v={video_id}",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
    if proc.returncode != 0:
        raise RuntimeError(stderr.decode().strip())

    title, duration = stdout.decode().strip().split("\n", 1)
    meta = {
        "video_id": video_id,
        "title": title,
        "duration": int(float(duration)),
        "thumbnail": f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg",
    }
    _meta_cache[video_id] = (meta, now)
    return meta


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


if __name__ == "__main__":
    asyncio.run(main())
