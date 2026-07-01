#!/usr/bin/env node
// yt-hls — minimal local HLS gateway.
//
//   YouTube video id  →  a local .m3u8 URL Safari (or any HLS player) can open.
//
// How it works (one job, three stages):
//   1. ACCESS   resolve a playable SABR stream for the id, bypassing the
//               bot-wall. This is the part lifted wholesale from youthub:
//                 · pr_fetch.py — fetches playerResponse.streamingData via a
//                   sticky rotation of TLS/IP/endpoint fingerprints.
//                 · youtubei.js — n-deciphers the serverAbrStreamingUrl.
//                 · po_token.mjs — mints a content-bound PO Token (bgutils,
//                   no browser).
//   2. PULL     googlevideo SabrStream pulls HD video + audio fMP4 buffers
//               (POST-based SABR protocol — the thing Safari can't speak).
//   3. REPACK   ffmpeg remuxes the two streams into HLS on the fly
//               (`-c copy -f hls`) and writes a growing playlist + segments.
//               The HTTP server then hands that playlist to the client.
//
// Safari constraint: native HLS needs H.264 video + AAC audio. YouTube's
// default best tracks are VP9 + Opus, which Safari can't play. So we
// explicitly pick H.264 + AAC itags; if a video only ships VP9/Opus we
// transcode that one stream (slower, rare).
//
// Usage:
//   node server.mjs                       # listen on 127.0.0.1:8730
//   PORT=9000 HOST=0.0.0.0 node server.mjs # expose to the LAN
//
// Endpoints:
//   GET /play/<id>            → text/JSON: metadata (title, duration, delivered
//                                codecs) + the hls & download URLs (starts the session)
//   GET /hls/<id>/index.m3u8  → the live HLS playlist (lazy-starts on first hit)
//   GET /hls/<id>/<segment>   → a media segment
//   GET /healthz              → "ok"

import { SabrStream } from 'googlevideo/sabr-stream';
import { Innertube } from 'youtubei.js';
import { Platform } from './node_modules/youtubei.js/dist/src/utils/Utils.js';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getPoToken } from './po_token.mjs';

const execFileP = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

// youtubei.js refuses to decipher signatures without a JS evaluator.
Platform.shim.eval = (data) => (new Function(data.output))();

// --------------------------- config ---------------------------

const PORT = Number(process.env.PORT || 8730);
const HOST = process.env.HOST || '127.0.0.1';
const PYTHON = process.env.YT_HLS_PYTHON || path.join(ROOT, '.venv/bin/python3.11');
const PR_FETCH = path.join(ROOT, 'pr_fetch.py');
const SESSIONS_DIR = process.env.YT_HLS_SESSIONS || path.join(ROOT, 'sessions');

// MAX_ATTEMPTS aligned with pr_fetch.STRATEGIES length (12 bases × 2 = 24).
const PR_FETCH_MAX_ATTEMPTS = 24;
const PR_FETCH_TIMEOUT_MS = 25_000;

// HLS segment length. Short → playlist appears (and Safari starts) sooner;
// `-c copy` can only cut on keyframes, so the real length is "≥ this, at the
// next keyframe".
const HLS_TIME = 2;
const PLAYLIST_WAIT_MS = 45_000;   // how long /play waits for the first segment
const SESSION_IDLE_MS = 30 * 60_000; // reap a session after this much idle time

// Safari is picky about codecs in an HLS-TS container. Copy these; transcode
// anything else.
const H264_VIDEO = [299, 298, 137, 136, 135, 134, 133];           // avc1, hi→lo
const VP9_VIDEO  = [303, 308, 248, 247, 244, 243, 242, 278];      // fallback
const AAC_AUDIO  = [140, 139, 256, 258, 327];                     // mp4a

const VIDEO_PRIORITY = [...H264_VIDEO, ...VP9_VIDEO];

// --------------------------- trim (from/to) config ---------------------------
// A trimmed request (?from=..&to=..) produces a finite VOD playlist instead of
// the growing EVENT one. Precision is per-edge and driven by the presence of a
// decimal point in the query value:
//   · integer edge (35)    → keyframe-approximate: pure `-c copy`, the cut lands
//                            on the nearest keyframe (no re-encode).
//   · float edge   (35.72) → exact: smart-cut — re-encode ONLY that boundary
//                            GOP, copy everything else.
// So the body of the clip is always `-c copy`; at most one GOP per exact edge
// gets re-encoded.
const PULL_PREROLL_S = 3;      // start the SABR pull this far before `from`
const PULL_TAIL_MARGIN_S = 5;  // pull this far past `to` (room for the tail GOP)
const REENCODE_V = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];
const REENCODE_A = ['-c:a', 'aac', '-b:a', '160k'];
const EPS = 0.03;              // seconds; ignore sub-frame boundary slivers

// EnabledTrackTypes.AUDIO_ONLY from googlevideo — tell SabrStream to download
// only the audio track (skip the whole video download) for the &x=1 mode.
const SABR_AUDIO_ONLY = 1;

const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

// How long a full-video download waits for the whole SABR pull to finish (the
// EVENT playlist grows until ffmpeg writes ENDLIST). Trimmed downloads are ready
// as soon as the VOD playlist is assembled and don't use this.
const DOWNLOAD_FULL_WAIT_MS = 15 * 60_000;

function ts() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function log(msg) { process.stderr.write(`${ts()} [yt-hls] ${msg}\n`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------- playerResponse (bot-wall bypass) ---------------------------

function extractPlayerResponse(html) {
  const patterns = [
    /var ytInitialPlayerResponse\s*=\s*({.+?})\s*;\s*var/s,
    /ytInitialPlayerResponse\s*=\s*({.+?})\s*;\s*<\/script>/s,
    /ytInitialPlayerResponse"\s*:\s*({.+?}),\s*"ytInitialData"/s,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) { try { return JSON.parse(m[1]); } catch { /* try next */ } }
  }
  return null;
}

// Loop pr_fetch.py until a strategy returns streamingData or the rotation
// is exhausted. pr_fetch is atomic (one fingerprint per call, marks dead on
// bot-wall, advances its sticky pointer); the loop walks the whole rotation.
async function fetchPlayerResponse(vid) {
  log(`/watch via pr_fetch (rotation, up to ${PR_FETCH_MAX_ATTEMPTS} strategies)`);
  let lastReason = 'no attempt';
  for (let attempt = 1; attempt <= PR_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      const t0 = Date.now();
      const { stdout, stderr } = await execFileP(PYTHON, [PR_FETCH, vid], {
        timeout: PR_FETCH_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: process.env,  // pass HTTPS_PROXY through
      });
      const ms = Date.now() - t0;
      const strat = stderr?.match(/using (\S+ \(round \d+\))/)?.[1] ?? '?';
      let fetched;
      try { fetched = JSON.parse(stdout); }
      catch (e) {
        lastReason = `JSON parse failed: ${e?.message ?? e}`;
        log(`attempt ${attempt}/${PR_FETCH_MAX_ATTEMPTS}: ${lastReason}`);
        continue;
      }
      if (fetched && fetched.streamingData) {
        log(`pr_fetch ok in ${ms}ms (attempt ${attempt}/${PR_FETCH_MAX_ATTEMPTS}, ${strat})`);
        return fetched;
      }
      lastReason = fetched?.playabilityStatus?.reason
        || fetched?.playabilityStatus?.status || 'no streamingData';
      log(`pr_fetch returned unplayable: ${lastReason} — stopping rotation`);
      break;  // the *video* is the problem; rotating won't help
    } catch (e) {
      // execFileP throws on non-zero exit (pr_fetch exits 2 on bot-wall after
      // advancing its pointer), timeout, or process error → next iter gets a
      // fresh fingerprint automatically.
      lastReason = e?.message ?? String(e);
      log(`attempt ${attempt}/${PR_FETCH_MAX_ATTEMPTS} died: ${e?.code || ''} ${lastReason.split('\n')[0]}`);
    }
  }
  log(`pr_fetch rotation exhausted (last reason: ${lastReason})`);
  // Last-ditch Node fetch — usually walled too, but the extra log line helps.
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${vid}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0',
        'Accept': 'text/html,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cookie': 'CONSENT=YES+; SOCS=CAI',
      },
    });
    if (res.ok) {
      const fetched = extractPlayerResponse(await res.text());
      if (fetched && fetched.streamingData) return fetched;
    } else { log(`Node /watch HTTP ${res.status}`); }
  } catch (e) { log(`Node /watch threw: ${e?.message ?? e}`); }
  return null;
}

// --------------------------- format helpers ---------------------------

function toNum(v) {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toSabrFormat(f) {
  return {
    itag: f.itag, lastModified: f.lastModified, xtags: f.xtags,
    width: f.width, height: f.height,
    contentLength: toNum(f.contentLength),
    audioTrackId: f.audioTrack?.id, mimeType: f.mimeType, isDrc: f.isDrc,
    quality: f.quality, qualityLabel: f.qualityLabel,
    averageBitrate: toNum(f.averageBitrate),
    bitrate: toNum(f.bitrate) ?? 0,
    audioQuality: f.audioQuality,
    approxDurationMs: toNum(f.approxDurationMs) ?? 0,
    language: f.language, isDubbed: f.isDubbed, isOriginal: f.isOriginal,
    audioIsDefault: f.audioTrack?.audioIsDefault === true,
    audioTrackDisplayName: f.audioTrack?.displayName,
  };
}

// Resolve everything SabrStream needs: deciphered URL, ustreamer cfg, PO Token,
// formats, and a Safari-friendly itag pair.
async function resolveVideo(vid, wantVp9 = false, audioOnly = false) {
  const pr = await fetchPlayerResponse(vid);
  if (!pr) {
    throw new Error(
      'YT bot-wall: every fingerprint refused and no cache. Your IP is '
      + 'likely rate-limited — wait 15–60 min or change the proxy and retry.');
  }
  const ps = pr.playabilityStatus, sd = pr.streamingData;
  if (!sd) throw new Error(`no streamingData (reason: ${ps?.reason || ps?.status})`);

  const rawSabr = sd.serverAbrStreamingUrl;
  if (!rawSabr) {
    throw new Error('playerResponse has no serverAbrStreamingUrl '
      + '(progressive/HLS-only payload — unsupported here)');
  }
  const ustreamerCfg = pr.playerConfig?.mediaCommonConfig
    ?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;
  const allFormats = (sd.adaptiveFormats ?? []).map(toSabrFormat);
  const durationMs = Number(pr.videoDetails?.lengthSeconds ?? 0) * 1000;
  const title = pr.videoDetails?.title ?? vid;
  log(`"${title}" — ${allFormats.length} formats, ${Math.round(durationMs / 1000)}s`);

  // n-decipher the SABR URL (encrypted n/sig params, always present).
  const yt = await Innertube.create({
    client_type: 'WEB', generate_session_locally: true,
  });
  const sabrUrl = await yt.session.player.decipher(rawSabr);

  // Content-bound PO Token (bound to videoId for /videoplayback).
  let poToken;
  const visitorData = pr.responseContext?.visitorData
    || pr.responseContext?.serviceTrackingParams
        ?.flatMap((s) => s.params || [])
        ?.find((p) => p.key === 'visitor_data')?.value;
  if (visitorData) {
    try {
      const t0 = Date.now();
      poToken = await getPoToken(visitorData, vid);
      log(`PO Token ready (${poToken.length}B in ${Date.now() - t0}ms)`);
    } catch (e) {
      log(`PO Token failed: ${e?.message ?? e} — trying without`);
    }
  } else {
    log('no visitorData — proceeding without PO Token');
  }

  // Pick a Safari-playable pair: H.264 video, AAC audio. Fall back to VP9/Opus
  // (will be transcoded) only if H.264/AAC are absent.
  const itags = new Set(allFormats.map((f) => f.itag));
  // YT_HLS_FORCE_VP9 (debug): prefer VP9 even when H.264 exists, so the vp9=1
  // path can be exercised on any video without hunting for a VP9-only upload.
  const priority = process.env.YT_HLS_FORCE_VP9
    ? [...VP9_VIDEO, ...H264_VIDEO] : VIDEO_PRIORITY;
  const pickVideoItag = priority.find((t) => itags.has(t));
  const videoIsH264 = H264_VIDEO.includes(pickVideoItag);

  const audioFormats = allFormats.filter((f) => f.mimeType?.includes('audio'));
  const aacFormats = audioFormats.filter((f) => AAC_AUDIO.includes(f.itag));
  const pickAac =
       aacFormats.find((f) => f.audioIsDefault === true)
    || aacFormats.find((f) => (f.audioTrackId || '').startsWith('ru'))
    || aacFormats[0];
  // Fall back to any audio (Opus etc.) — ffmpeg will transcode to AAC.
  const pickAudio = pickAac
    || audioFormats.find((f) => f.audioIsDefault === true)
    || audioFormats[0];
  const audioIsAac = !!pickAac;

  if (pickVideoItag === undefined || !pickAudio) {
    throw new Error('no usable video/audio itag pair in adaptiveFormats');
  }
  // vp9=1: when the source is VP9-only (no H.264 pick), copy VP9 instead of
  // transcoding it to H.264. VP9 can't live in mpegts, so this forces the whole
  // session onto fMP4 segments, and audio is copied too (Opus stays Opus). Only
  // playable outside Safari (Chrome/hls.js/ffplay). A no-op when H.264 exists.
  // Never in audio-only mode (there is no video to pass through).
  const vp9Passthrough = wantVp9 && !videoIsH264 && !audioOnly;
  // x=1: audio-only output — we still resolve a video itag (SabrStream.start
  // wants one), but ask SABR to download audio only and mux just the audio.
  const videoDesc = audioOnly ? 'audio-only (no video)'
    : videoIsH264 ? 'H.264 copy'
    : vp9Passthrough ? 'VP9 copy (fMP4)' : 'VP9→transcode';
  log(`picked video=itag ${pickVideoItag} (${videoDesc}) `
    + `audio=itag ${pickAudio.itag} (${(audioIsAac || vp9Passthrough) ? 'copy' : 'Opus→transcode'})`);

  return {
    sabrUrl, ustreamerCfg, allFormats, durationMs, poToken, title,
    pickVideoItag, pickAudio, videoIsH264, audioIsAac, vp9Passthrough, audioOnly,
  };
}

// The codecs the client will ACTUALLY receive — not the source's. A VP9→H.264
// transcode is reported as `h264` (that's what leaves the muxer); audio always
// ends up AAC unless it's copied through in vp9 mode (then it's the source's).
// video is null in audio-only mode. Stored on the session and surfaced by /play.
function resolvedMeta(ctx) {
  return {
    title: ctx.title,
    durationMs: ctx.durationMs,
    video: ctx.audioOnly ? null : ctx.vp9Passthrough ? 'vp9' : 'h264',
    audio: (ctx.vp9Passthrough && !ctx.audioIsAac) ? 'opus' : 'aac',
  };
}

// Human-readable H:MM:SS / M:SS for the /play plain-text response.
function fmtDuration(ms) {
  const s = Math.round((ms || 0) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// --------------------------- HLS session ---------------------------

/** @type {Map<string, {dir:string, ffmpeg:any, sabr:any, ready:Promise<any>, lastAccess:number, ended:boolean}>} */
const sessions = new Map();

// Parse ?from=..&to=.. into a trim spec, or null (full video), or 'bad'.
// A decimal point in a value means "exact edge" (smart-cut); a bare integer
// means "approximate to the nearest keyframe" (pure copy).
function parseTrim(sp) {
  const f = sp.get('from'), t = sp.get('to');
  if (f == null && t == null) return null;
  const from = f == null ? 0 : Number(f);
  const to = t == null ? Infinity : Number(t);
  if (!Number.isFinite(from) || from < 0) return 'bad';
  if (t != null && (!Number.isFinite(to) || to <= from)) return 'bad';
  return {
    from, to,
    fromExact: f != null && f.includes('.'),
    toExact: t != null && t.includes('.'),
    raw: { from: f, to: t },
  };
}

// A filesystem-safe, collision-free session key per (video, range).
function trimKey(vid, trim) {
  const f = trim.raw.from ?? '0', t = trim.raw.to ?? 'end';
  return `${vid}__${f}-${t}`.replace(/[^A-Za-z0-9_-]/g, 'p');
}

// The query string to graft back onto segment URIs in a trimmed playlist, so
// the player carries ?from&to on every segment fetch (relative resolution drops
// the parent query otherwise) and we can route it back to the right session.
function trimQuery(trim) {
  const p = [];
  if (trim.raw.from != null) p.push(`from=${trim.raw.from}`);
  if (trim.raw.to != null) p.push(`to=${trim.raw.to}`);
  return p.join('&');
}

// Everything a segment/init URI must carry to route back to the same session:
// the trim range and the flags that change the produced content (both are part
// of the session key). `dl` is NOT here — it changes delivery, not content, so a
// download reuses the exact same session/segments as playback.
function sessionQuery(trim, wantVp9, wantAudioOnly) {
  const p = [];
  if (trim) p.push(trimQuery(trim));
  // x=1 (audio-only) has no video, so vp9 is irrelevant — never emit both.
  if (wantAudioOnly) p.push('x=1');
  else if (wantVp9) p.push('vp9=1');
  return p.filter(Boolean).join('&');
}

function ensureSession(vid, trim, wantVp9 = false, wantAudioOnly = false) {
  let key = trim ? trimKey(vid, trim) : vid;
  if (wantAudioOnly) key += '__x';
  else if (wantVp9) key += '__vp9';
  let s = sessions.get(key);
  if (s) { s.lastAccess = Date.now(); return s; }
  s = {
    key,
    dir: path.join(SESSIONS_DIR, key),
    ffmpeg: null, sabr: null, ready: null, procs: new Set(),
    lastAccess: Date.now(), ended: false,
    wantVp9: !!wantVp9 && !wantAudioOnly, audioOnly: !!wantAudioOnly, fmp4: false,
    title: vid, dlPromise: null, finishedResolve: null,
  };
  // Resolves when the produced playlist is final (trim: build done; full: ffmpeg
  // exits with ENDLIST). A full-video download awaits this.
  s.finished = new Promise((r) => { s.finishedResolve = r; });
  sessions.set(key, s);
  // Single-flight: everyone awaits the same start promise. On failure, drop
  // the session so the next request can retry cleanly.
  const build = trim
    ? () => buildTrimmedSession(vid, s, trim)
    : () => startFullSession(vid, s);
  s.ready = build().catch((err) => {
    sessions.delete(key);
    throw err;
  });
  return s;
}

// SabrStream is constructed identically for the full-session pull and the
// trim-range pull — one factory keeps them in lockstep.
function makeSabr(vid, s, ctx) {
  const sabr = new SabrStream({
    fetch: (url, init = {}) => {
      const headers = new Headers(init.headers ?? {});
      if (!headers.has('User-Agent')) headers.set('User-Agent', CHROME_UA);
      return fetch(url, { ...init, headers });
    },
    serverAbrStreamingUrl: ctx.sabrUrl,
    videoPlaybackUstreamerConfig: ctx.ustreamerCfg,
    poToken: ctx.poToken,
    clientInfo: { clientName: 1, clientVersion: '2.20260206.01.00' },
    durationMs: ctx.durationMs,
    formats: ctx.allFormats,
  });
  s.sabr = sabr;
  sabr.on('error', (e) => log(`[${vid}] sabr error: ${e?.message ?? e}`));
  return sabr;
}

// SabrStream.start options; audio-only (x=1) tells the server to skip the video
// download entirely (a video itag is still required to select formats).
function sabrStartOpts(ctx, startAtMs) {
  const o = { videoFormat: ctx.pickVideoItag, audioFormat: ctx.pickAudio, startAtMs };
  if (ctx.audioOnly) o.enabledTrackTypes = SABR_AUDIO_ONLY;
  return o;
}

async function startFullSession(vid, s) {
  const ctx = await resolveVideo(vid, s.wantVp9, s.audioOnly);
  s.title = ctx.title;
  s.meta = resolvedMeta(ctx);
  s.fmp4 = !!ctx.vp9Passthrough;   // VP9 copy → fMP4 segments (init.mp4 + .m4s)
  await fs.promises.rm(s.dir, { recursive: true, force: true });
  await fs.promises.mkdir(s.dir, { recursive: true });
  const indexPath = path.join(s.dir, 'index.m3u8');

  // vp9Passthrough copies both tracks as-is; otherwise copy H.264/AAC, transcode
  // the rest to the Safari-playable pair.
  const videoCodec = (ctx.videoIsH264 || ctx.vp9Passthrough)
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
  const audioCodec = (ctx.audioIsAac || ctx.vp9Passthrough)
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', '160k'];

  // `event` playlist = growing VOD, seek-backward allowed, ENDLIST appended when
  // the stream finishes. Audio-only (x=1): one input (audio pipe:3), mux just the
  // audio to mpegts. Otherwise pipe:3 = video, pipe:4 = audio.
  let ffArgs, stdio;
  if (s.audioOnly) {
    ffArgs = [
      '-hide_banner', '-loglevel', 'warning',
      '-thread_queue_size', '16384', '-i', 'pipe:3',
      '-map', '0:a:0', ...audioCodec,
      '-f', 'hls', '-hls_time', String(HLS_TIME),
      '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(s.dir, 'seg%05d.ts'),
      '-y', indexPath,
    ];
    stdio = ['ignore', 'inherit', 'inherit', 'pipe'];
  } else {
    const segCodec = s.fmp4
      ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
         '-hls_segment_filename', path.join(s.dir, 'seg%05d.m4s')]
      : ['-hls_segment_type', 'mpegts',
         '-hls_segment_filename', path.join(s.dir, 'seg%05d.ts')];
    ffArgs = [
      '-hide_banner', '-loglevel', 'warning',
      '-thread_queue_size', '16384', '-i', 'pipe:3',
      '-thread_queue_size', '16384', '-i', 'pipe:4',
      '-map', '0:v:0', '-map', '1:a:0',
      ...videoCodec, ...audioCodec,
      '-f', 'hls', '-hls_time', String(HLS_TIME),
      '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments',
      ...segCodec,
      '-y', indexPath,
    ];
    stdio = ['ignore', 'inherit', 'inherit', 'pipe', 'pipe'];
  }
  const ffmpeg = spawn('ffmpeg', ffArgs, { stdio });
  s.ffmpeg = ffmpeg;
  s.procs.add(ffmpeg);
  ffmpeg.on('exit', (code, sig) => {
    s.ended = true;
    s.procs.delete(ffmpeg);
    s.finishedResolve?.();  // unblock a pending full-video download
    log(`[${vid}] ffmpeg exit code=${code} sig=${sig}`);
  });

  const sabr = makeSabr(vid, s, ctx);
  const { videoStream, audioStream } = await sabr.start(sabrStartOpts(ctx, 0));

  async function pump(name, readable, writable) {
    const reader = readable.getReader();
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (!writable.write(value)) {
          await new Promise((r) => writable.once('drain', r));
        }
      }
    } catch (e) { log(`[${vid}] ${name} pump error: ${e?.message ?? e}`); }
    finally {
      try { writable.end(); } catch { /* */ }
      log(`[${vid}] ${name} pump done, ${(total / 1e6).toFixed(1)}MB`);
    }
  }
  const pumps = s.audioOnly
    ? [pump('audio', audioStream, ffmpeg.stdio[3])]
    : [pump('video', videoStream, ffmpeg.stdio[3]),
       pump('audio', audioStream, ffmpeg.stdio[4])];
  Promise.all(pumps).catch((e) => log(`[${vid}] pumps crashed: ${e?.message ?? e}`));

  // "Ready" = ffmpeg has flushed the first segment into the playlist.
  await waitForPlaylist(indexPath, PLAYLIST_WAIT_MS, ffmpeg);
  log(`[${vid}] HLS ready → ${indexPath}`);
  return s;
}

async function waitForPlaylist(indexPath, timeoutMs, ffmpeg) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ffmpeg.exitCode !== null) {
      throw new Error(`ffmpeg exited (code ${ffmpeg.exitCode}) before writing a segment`);
    }
    try {
      const txt = await fs.promises.readFile(indexPath, 'utf8');
      if (txt.includes('#EXTINF')) return;
    } catch { /* not written yet */ }
    await sleep(250);
  }
  throw new Error('timed out waiting for the HLS playlist (no segments produced)');
}

// --------------------------- trimmed (VOD) session ---------------------------
//
// Design goal: exact-ish trim WITHOUT re-encoding the body, and with ZERO A/V
// drift. The drift trap is `concat -c copy`, which re-bases each stream by its
// own length; since a part's video and audio lengths differ by up to one frame,
// every splice shifts A/V by ~20ms. We avoid it entirely:
//   · audio is NEVER re-encoded — AAC frames are independent, so we copy-cut it
//     on its own ~21ms grid; exact edges are snapped to that grid.
//   · each part (head/body/tail) is a self-contained HLS with video+audio muxed
//     in one ffmpeg pass, so A/V is in sync within the part exactly as in the
//     source; only the boundary video GOP of an exact edge is re-encoded.
//   · parts are stitched at the PLAYLIST level with #EXT-X-DISCONTINUITY, so the
//     player resets the timeline per part and never re-bases streams → no drift.

function runFfmpeg(args, s) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args],
      { stdio: ['ignore', 'inherit', 'inherit'] });
    s?.procs?.add(p);
    p.on('error', (e) => { s?.procs?.delete(p); reject(e); });
    p.on('exit', (code, sig) => {
      s?.procs?.delete(p);
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code} ${sig || ''}`));
    });
  });
}

async function pumpStream(name, readable, writable, tag) {
  const reader = readable.getReader();
  let total = 0;
  // ffmpeg closes the pipe the moment it hits `-t`; the resulting async EPIPE is
  // an 'error' event on the writable (not a throw), so swallow it here.
  writable.on('error', () => {});
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (writable.writableEnded || writable.destroyed) break;
      if (!writable.write(value)) await new Promise((r) => writable.once('drain', r));
    }
  } catch (e) { log(`[${tag}] ${name} pump: ${e?.message ?? e}`); }
  finally { try { writable.end(); } catch { /* */ } }
  return total;
}

async function probeKeyframes(file) {
  // Use packet flags, not `-skip_frame nokey`: the latter reports frames in
  // decode order AND misses non-IDR keyframes (open-GOP I-frames), which would
  // put the copy boundary on the wrong keyframe. The packet "K" flag marks every
  // real keyframe.
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file,
  ], { maxBuffer: 128 * 1024 * 1024 });
  const kf = [];
  for (const line of stdout.split('\n')) {
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    if (!line.slice(comma + 1).includes('K')) continue;
    const t = parseFloat(line.slice(0, comma));
    if (Number.isFinite(t)) kf.push(t);
  }
  return kf.sort((a, b) => a - b);
}

async function probeAudioRate(file) {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', file,
    ]);
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

async function probeStartTime(file) {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', file,
    ]);
    const n = parseFloat(stdout.trim());
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

// Pull only [from-preroll, to+margin] of the SABR stream into a seekable temp,
// normalised to H.264/AAC and carrying original timestamps (`-copyts`) so the
// probe below reports keyframes in absolute video seconds.
async function pullRangeToTemp(vid, s, ctx, from, to, tmpPath) {
  const startSec = Math.max(0, Math.floor(from) - PULL_PREROLL_S);
  // With -copyts the temp keeps absolute timestamps, so bound the pull by the
  // absolute end position (-to), NOT -t (which counts from timestamp 0 and would
  // truncate the clip to just `to` seconds of content starting at ~0).
  const endAbs = to + PULL_TAIL_MARGIN_S;
  const vCodec = (ctx.videoIsH264 || ctx.vp9Passthrough)
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];
  const aCodec = (ctx.audioIsAac || ctx.vp9Passthrough) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k'];

  // Audio-only (x=1): pull just the audio track (one input, one map). Otherwise
  // pull both video + audio into a matroska temp.
  const ff = ctx.audioOnly
    ? spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-copyts',
        '-thread_queue_size', '16384', '-i', 'pipe:3',
        '-map', '0:a:0', ...aCodec,
        '-to', String(endAbs), '-f', 'matroska', '-y', tmpPath,
      ], { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] })
    : spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-copyts',
        '-thread_queue_size', '16384', '-i', 'pipe:3',
        '-thread_queue_size', '16384', '-i', 'pipe:4',
        '-map', '0:v:0', '-map', '1:a:0', ...vCodec, ...aCodec,
        '-to', String(endAbs), '-f', 'matroska', '-y', tmpPath,
      ], { stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe'] });
  s.procs.add(ff);
  const ffExit = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('exit', (code) => {
      s.procs.delete(ff);
      (code === 0 || code === null) ? resolve()
        : reject(new Error(`range ffmpeg exit ${code}`));
    });
  });

  const sabr = makeSabr(vid, s, ctx);
  const { videoStream, audioStream } = await sabr.start(sabrStartOpts(ctx, startSec * 1000));
  // When ffmpeg reaches -t it closes the pipes; the pumps then end and we abort
  // SabrStream so it stops downloading the rest of the video.
  const pumps = ctx.audioOnly
    ? [pumpStream('audio', audioStream, ff.stdio[3], vid)]
    : [pumpStream('video', videoStream, ff.stdio[3], vid),
       pumpStream('audio', audioStream, ff.stdio[4], vid)];
  Promise.all(pumps).catch(() => {});
  await ffExit;
  try { sabr.abort(); } catch { /* */ }
  return startSec;
}

// Produce one part as its own little VOD HLS (video+audio muxed together).
//   reencode=false → `-c copy` (body); reencode=true → re-encode video only,
//   copy audio (exact boundary GOP). inSs seeks the input to a keyframe; outSs
//   (>0 only for an exact `from`) trims the decoded head to the precise start.
async function producePartHls(s, tmp, partDir, part) {
  await fs.promises.mkdir(partDir, { recursive: true });
  // Body = pure copy. The mp4 keeps SPS/PPS out-of-band (in avcC), and an input
  // `-ss` seek drops the SPS/PPS that precede the target keyframe, so the first
  // copied segment would be undecodable. h264_mp4toannexb converts to in-band
  // Annex-B, and dump_extra=freq=keyframe re-injects SPS/PPS before EVERY
  // keyframe → every HLS segment is self-decodable. Re-encoded parts (libx264 →
  // mpegts) already carry per-segment SPS/PPS, so they need no filter.
  // s.fmp4 (VP9 passthrough) keeps the stream VP9: exact edges re-encode with
  // libvpx-vp9 (NOT libx264 — can't mix codecs in one rendition), the body is a
  // pure copy, and segments are fMP4 (VP9 is invalid in mpegts). The h264 bsf is
  // H.264-only, so it's dropped for VP9 (fMP4 carries the config in init.mp4).
  let codec;
  if (part.reencode) {
    codec = s.fmp4
      ? ['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-deadline', 'good',
         '-cpu-used', '5', '-pix_fmt', 'yuv420p', '-c:a', 'copy']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy'];
  } else {
    codec = s.fmp4
      ? ['-c', 'copy']
      : ['-c', 'copy', '-bsf:v', 'h264_mp4toannexb,dump_extra=freq=keyframe'];
  }
  const args = ['-ss', String(part.inSs), '-i', tmp];
  if (part.outSs > 1e-3) args.push('-ss', String(part.outSs));
  args.push('-t', String(part.dur), '-map', '0:v:0', '-map', '0:a:0', ...codec,
    '-f', 'hls', '-hls_time', String(HLS_TIME), '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments');
  if (s.fmp4) {
    args.push('-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(partDir, 'p%05d.m4s'));
  } else {
    args.push('-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(partDir, 'p%05d.ts'));
  }
  args.push('-y', path.join(partDir, 'idx.m3u8'));
  await runFfmpeg(args, s);
}

// Merge the parts' segment lists into one VOD playlist, renumbering segment
// files into the session dir and inserting #EXT-X-DISCONTINUITY between parts.
async function assembleFromParts(partDirs, outDir, fmp4) {
  const ext = fmp4 ? 'm4s' : 'ts';
  const entries = [];
  let maxDur = 0;
  for (let i = 0; i < partDirs.length; i++) {
    // Each fMP4 part ships its own init.mp4 (the re-encoded edges differ from the
    // copied body), so keep them per-part and emit an #EXT-X-MAP before each part.
    let mapName = null;
    if (fmp4) {
      mapName = `init${i}.mp4`;
      await fs.promises.rename(path.join(partDirs[i], 'init.mp4'), path.join(outDir, mapName));
    }
    const m = await fs.promises.readFile(path.join(partDirs[i], 'idx.m3u8'), 'utf8');
    const lines = m.split('\n');
    let firstOfPart = true;
    for (let j = 0; j < lines.length; j++) {
      if (!lines[j].startsWith('#EXTINF:')) continue;
      const dur = parseFloat(lines[j].slice(8));
      let k = j + 1;
      while (k < lines.length && (lines[k].startsWith('#') || lines[k].trim() === '')) k++;
      const src = lines[k]?.trim();
      if (!src) continue;
      const dst = `seg${String(entries.length).padStart(5, '0')}.${ext}`;
      await fs.promises.rename(path.join(partDirs[i], src), path.join(outDir, dst));
      entries.push({
        dur, file: dst,
        disc: i > 0 && firstOfPart,       // reset the timeline between parts
        map: firstOfPart ? mapName : null, // (fMP4 only) init before each part
      });
      firstOfPart = false;
      if (dur > maxDur) maxDur = dur;
    }
  }
  let out = `#EXTM3U\n#EXT-X-VERSION:${fmp4 ? 7 : 3}\n#EXT-X-PLAYLIST-TYPE:VOD\n`
    + `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(maxDur))}\n`
    + '#EXT-X-MEDIA-SEQUENCE:0\n';
  for (const e of entries) {
    if (e.disc) out += '#EXT-X-DISCONTINUITY\n';
    if (e.map) out += `#EXT-X-MAP:URI="${e.map}"\n`;
    out += `#EXTINF:${e.dur.toFixed(6)},\n${e.file}\n`;
  }
  out += '#EXT-X-ENDLIST\n';
  await fs.promises.writeFile(path.join(outDir, 'index.m3u8'), out);
  return entries.length;
}

// Audio has no keyframe constraints — every AAC/Opus frame is independent — so a
// trimmed audio clip is a plain copy-cut of [from,to] into one VOD playlist (no
// head/body/tail smart-cut, no discontinuities, no re-encode). Both integer and
// decimal edges are effectively exact to the audio-frame grid.
async function buildTrimmedAudioSession(vid, s, trim, ctx) {
  const durSec = ctx.durationMs / 1000 || 0;
  let from = Math.max(0, trim.from);
  let to = trim.to === Infinity ? (durSec || trim.to) : trim.to;
  if (durSec) to = Math.min(to, durSec);
  if (!(to > from)) throw new Error(`bad range: from=${from} to=${to}`);

  const rawTmp = path.join(s.dir, 'range.mkv');
  log(`[${vid}] trim(audio) ${from}→${to} — pulling range`);
  await pullRangeToTemp(vid, s, ctx, from, to, rawTmp);

  // The pulled mkv carries absolute, seek-hostile timestamps; remux to a clean
  // 0-based m4a and cut in that local timeline (origin = mkv start_time).
  const pullOrigin = await probeStartTime(rawTmp);
  const tmp = path.join(s.dir, 'range.m4a');
  await runFfmpeg(['-i', rawTmp, '-map', '0:a:0', '-c:a', 'copy',
    '-movflags', '+faststart', '-y', tmp], s);
  await fs.promises.rm(rawTmp, { force: true }).catch(() => {});

  const sr = await probeAudioRate(tmp);
  const frameDur = sr ? (ctx.audioIsAac ? 1024 / sr : 0.02) : 0;
  let fromL = Math.max(0, from - pullOrigin);
  let toL = to - pullOrigin;
  if (frameDur) { fromL = Math.round(fromL / frameDur) * frameDur; toL = Math.round(toL / frameDur) * frameDur; }

  await runFfmpeg(['-ss', String(fromL), '-i', tmp, '-t', String(Math.max(0.05, toL - fromL)),
    '-map', '0:a:0', '-c:a', 'copy',
    '-f', 'hls', '-hls_time', String(HLS_TIME), '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments', '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(s.dir, 'seg%05d.ts'),
    '-y', path.join(s.dir, 'index.m3u8')], s);

  if (!process.env.YT_HLS_KEEP_TMP) await fs.promises.rm(tmp, { force: true }).catch(() => {});
  log(`[${vid}] trim(audio) ready: ${fromL.toFixed(2)}→${toL.toFixed(2)} → ${s.dir}/index.m3u8`);
  return s;
}

async function buildTrimmedSession(vid, s, trim) {
  const ctx = await resolveVideo(vid, s.wantVp9, s.audioOnly);
  s.title = ctx.title;
  s.meta = resolvedMeta(ctx);
  await fs.promises.rm(s.dir, { recursive: true, force: true });
  await fs.promises.mkdir(s.dir, { recursive: true });
  if (s.audioOnly) {
    const r = await buildTrimmedAudioSession(vid, s, trim, ctx);
    s.finishedResolve?.();
    return r;
  }
  s.fmp4 = !!ctx.vp9Passthrough;   // VP9 copy → fMP4 parts + libvpx-vp9 edges

  const durSec = ctx.durationMs / 1000 || 0;
  let from = Math.max(0, trim.from);
  let to = trim.to === Infinity ? (durSec || trim.to) : trim.to;
  if (durSec) to = Math.min(to, durSec);
  if (!(to > from)) throw new Error(`bad range: from=${from} to=${to}`);

  const rawTmp = path.join(s.dir, 'range.mkv');
  log(`[${vid}] trim ${from}→${to}  (from=${trim.fromExact ? 'exact' : 'approx'}, `
    + `to=${trim.toExact ? 'exact' : 'approx'}) — pulling range`);
  await pullRangeToTemp(vid, s, ctx, from, to, rawTmp);

  // The mkv pulled from a pipe carries absolute, seek-hostile timestamps (the
  // SABR fragments start at the real video time, e.g. ~30s). Remux to a clean
  // 0-based mp4 so `-ss` is reliable, and work in that LOCAL timeline —
  // converting the requested seconds with pullOrigin (the mp4's 0 = this time).
  const pullOrigin = await probeStartTime(rawTmp);
  const tmp = path.join(s.dir, 'range.mp4');
  await runFfmpeg(['-i', rawTmp, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy',
    '-movflags', '+faststart', '-y', tmp], s);
  await fs.promises.rm(rawTmp, { force: true }).catch(() => {});

  const KF = await probeKeyframes(tmp);            // local (0-based) keyframes
  if (!KF.length) throw new Error('no keyframes found in the pulled range');
  const sr = await probeAudioRate(tmp);
  // AAC frame = 1024 samples; Opus (VP9 passthrough) = 20ms. Exact edges snap to
  // this grid so the audio copy-cut stays frame-aligned (no A/V drift).
  const frameDur = sr ? (ctx.audioIsAac ? 1024 / sr : 0.02) : 0;

  // Requested times → local timeline.
  let fromL = Math.max(0, from - pullOrigin);
  let toL = to - pullOrigin;
  // Snap exact edges to the audio-frame grid so the outer boundaries land on a
  // real audio frame (keeps A/V perfectly aligned; still sub-second precision).
  if (trim.fromExact && frameDur) fromL = Math.round(fromL / frameDur) * frameDur;
  if (trim.toExact && frameDur) toL = Math.round(toL / frameDur) * frameDur;

  log(`[${vid}] range origin=${pullOrigin.toFixed(3)}s, KF n=${KF.length} `
    + `[${KF[0].toFixed(2)}..${KF.at(-1).toFixed(2)}] local, cut ${fromL.toFixed(3)}→${toL.toFixed(3)}`);

  const kfLE = (t) => { let r = KF[0]; for (const k of KF) { if (k <= t + 1e-6) r = k; else break; } return r; };
  const kfGT = (t) => { for (const k of KF) { if (k > t + 1e-6) return k; } return null; };

  const startKf = kfLE(fromL);
  const endKf = kfLE(toL);
  const bodyStart = trim.fromExact ? kfGT(fromL) : startKf;
  const bodyEnd = endKf;
  const bodyOk = bodyStart != null && (bodyEnd - bodyStart) > 0.05 && bodyStart < toL;

  const parts = [];
  if (!bodyOk) {
    // Whole clip fits in ≤1 GOP boundary — just re-encode [from,to] (no body).
    const eF = trim.fromExact ? fromL : startKf;
    const eT = trim.toExact ? toL : (endKf > eF ? endKf : (kfGT(fromL) ?? toL));
    parts.push({ name: 'single', reencode: true, inSs: kfLE(eF), outSs: eF - kfLE(eF), dur: Math.max(0.05, eT - eF) });
  } else {
    if (trim.fromExact && bodyStart - fromL > EPS) {
      parts.push({ name: 'head', reencode: true, inSs: kfLE(fromL), outSs: fromL - kfLE(fromL), dur: bodyStart - fromL });
    }
    parts.push({ name: 'body', reencode: false, inSs: bodyStart, outSs: 0, dur: bodyEnd - bodyStart });
    if (trim.toExact && toL - bodyEnd > EPS) {
      parts.push({ name: 'tail', reencode: true, inSs: bodyEnd, outSs: 0, dur: toL - bodyEnd });
    }
  }

  const partDirs = [];
  for (const part of parts) {
    const pd = path.join(s.dir, `part_${part.name}`);
    await producePartHls(s, tmp, pd, part);
    partDirs.push(pd);
  }
  const nSegs = await assembleFromParts(partDirs, s.dir, s.fmp4);

  if (!process.env.YT_HLS_KEEP_TMP) await fs.promises.rm(tmp, { force: true }).catch(() => {});
  for (const pd of partDirs) await fs.promises.rm(pd, { recursive: true, force: true }).catch(() => {});
  if (!nSegs) throw new Error('assembled playlist has no segments');

  log(`[${vid}] trim ready: ${parts.map((p) => p.name + (p.reencode ? '*' : '')).join('+')} `
    + `→ ${nSegs} segs, ${s.dir}/index.m3u8`);
  s.finishedResolve?.();
  return s;
}

async function stopSession(key) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  log(`[${key}] stopping session`);
  try { s.sabr?.abort(); } catch { /* */ }
  for (const p of s.procs) {
    try { if (p.exitCode === null) p.kill('SIGKILL'); } catch { /* */ }
  }
  try {
    if (s.ffmpeg && s.ffmpeg.exitCode === null) s.ffmpeg.kill('SIGKILL');
  } catch { /* */ }
  try { await fs.promises.rm(s.dir, { recursive: true, force: true }); } catch { /* */ }
}

// Reap idle sessions so disk + ffmpeg children don't pile up.
setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (now - s.lastAccess > SESSION_IDLE_MS) {
      log(`[${key}] idle ${Math.round((now - s.lastAccess) / 60000)}m — reaping`);
      stopSession(key).catch(() => {});
    }
  }
}, 60_000).unref();

// --------------------------- HTTP ---------------------------

const VID_RE = /^[A-Za-z0-9_-]{11}$/;

function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
    ...headers,
  });
  res.end(body);
}

function serveFile(res, filePath, contentType, extraHeaders = {}) {
  const stream = fs.createReadStream(filePath);
  stream.once('error', () => send(res, 404, 'not found\n', { 'Content-Type': 'text/plain' }));
  stream.once('open', () => {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      ...extraHeaders,
    });
    stream.pipe(res);
  });
}

// Remux the session's assembled playlist into one downloadable file (mp4 for
// video, m4a for audio-only) with `-c copy` — no re-encode, just repackaging the
// same segments the player already gets. Cached per session, single-flight.
function ensureDownloadFile(s) {
  if (!s.dlPromise) {
    s.dlPromise = (async () => {
      const ext = s.audioOnly ? 'm4a' : 'mp4';
      const out = path.join(s.dir, `download.${ext}`);
      // -allowed_extensions ALL lets the hls demuxer read local .ts/.m4s/.mp4
      // segments regardless of name; +faststart moves moov to the front so the
      // file is seekable/streamable right away.
      await runFfmpeg(['-allowed_extensions', 'ALL', '-i', path.join(s.dir, 'index.m3u8'),
        '-map', '0', '-c', 'copy', '-movflags', '+faststart', '-y', out], s);
      return out;
    })().catch((e) => { s.dlPromise = null; throw e; });
  }
  return s.dlPromise;
}

// A human download filename: "<title>[ from-to].<ext>", sanitised for a header.
function downloadName(s, trim, ext) {
  let base = (s.title || 'video').replace(/[\r\n"]/g, '').replace(/[/\\]/g, '-').trim();
  if (base.length > 120) base = base.slice(0, 120);
  if (trim) {
    const f = trim.raw.from ?? '0', t = trim.raw.to ?? 'end';
    base += ` ${f}-${t}`;
  }
  return `${base}.${ext}`;
}

// Serve a file as an attachment. RFC 5987 filename* carries the real (possibly
// non-ASCII) name; the plain filename is an ASCII fallback for old clients.
function serveDownload(res, filePath, contentType, name) {
  let size;
  try { size = fs.statSync(filePath).size; } catch { /* stream will 404 */ }
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  const headers = {
    'Content-Disposition': `attachment; filename="${ascii}"; `
      + `filename*=UTF-8''${encodeURIComponent(name)}`,
  };
  if (size != null) headers['Content-Length'] = String(size);
  serveFile(res, filePath, contentType, headers);
}

const HELP = `yt-hls — YouTube id → local HLS

  GET /play/<id>             → resolve: title, duration, delivered codecs +
                               the hls & download URLs (Accept: application/json → JSON)
  GET /hls/<id>/index.m3u8   → HLS playlist (paste this into Safari)
  GET /hls/<id>/<segment>    → media segment
  GET /dl/<id>               → download the clip/video as one file
  GET /healthz               → ok

Trim to a range with ?from=&to= (seconds):
  · integer (from=35)   → approximate: cut on the nearest keyframe, pure copy
  · decimal  (from=35.7)→ exact: smart-cut, only that boundary GOP is re-encoded
  audio is never re-encoded; exact edges snap to the audio-frame grid (no A/V drift)

Add &vp9=1 to copy VP9 instead of transcoding it (VP9-only sources): fMP4 output,
plays in Chrome/hls.js/ffplay but NOT Safari (Safari can't decode VP9).

Add &x=1 for audio only (no video track): only the audio is pulled and muxed
(AAC), so it's lighter and plays anywhere.

Download with /dl/<id>: same ?from&to / &x=1 selection, remuxed to one file (mp4,
or m4a for audio-only), Content-Disposition attachment. A full-video download
waits for the whole pull to finish. /play returns this URL too (as "download").

Examples:
  curl http://${HOST}:${PORT}/play/gofCdGw1VGA
  curl -H 'Accept: application/json' http://${HOST}:${PORT}/play/gofCdGw1VGA
  curl "http://${HOST}:${PORT}/hls/gofCdGw1VGA/index.m3u8?from=35&to=144"
  curl "http://${HOST}:${PORT}/hls/gofCdGw1VGA/index.m3u8?from=4.0&to=12"
  curl "http://${HOST}:${PORT}/hls/gofCdGw1VGA/index.m3u8?from=4.0&to=12&vp9=1"
  curl "http://${HOST}:${PORT}/hls/gofCdGw1VGA/index.m3u8?from=35&to=60&x=1"
  curl -OJ "http://${HOST}:${PORT}/dl/gofCdGw1VGA?from=35&to=60"
  curl -OJ "http://${HOST}:${PORT}/dl/gofCdGw1VGA?from=35&to=60&x=1"
`;

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); }
  catch { return send(res, 400, 'bad url\n', { 'Content-Type': 'text/plain' }); }
  const pathname = decodeURIComponent(url.pathname);
  const parts = pathname.split('/').filter(Boolean);

  const trim = parseTrim(url.searchParams);
  if (trim === 'bad') {
    return send(res, 400, 'bad from/to (need 0 <= from < to)\n', { 'Content-Type': 'text/plain' });
  }
  // vp9=1: copy VP9 instead of transcoding it (only affects VP9-only sources).
  const wantVp9 = url.searchParams.get('vp9') === '1';
  // x=1: audio-only (no video track).
  const wantAudioOnly = url.searchParams.get('x') === '1';

  if (pathname === '/' || pathname === '') {
    return send(res, 200, HELP, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (pathname === '/healthz') {
    return send(res, 200, 'ok\n', { 'Content-Type': 'text/plain' });
  }

  // GET /play/<id>[?from=&to=][&x=1][&vp9=1]  — resolve the video: start (if
  // needed) the session and return metadata the caller can't compute itself
  // (title, duration, the codecs actually delivered) plus both the HLS and the
  // download URLs. Accept: application/json → a machine-readable object.
  if (parts[0] === 'play' && parts.length === 2) {
    const vid = parts[1];
    if (!VID_RE.test(vid)) return send(res, 400, 'bad video id\n', { 'Content-Type': 'text/plain' });
    let s;
    try {
      s = ensureSession(vid, trim, wantVp9, wantAudioOnly);
      await s.ready;
    } catch (e) {
      return send(res, 502, `failed: ${e?.message ?? e}\n`, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const qs = sessionQuery(trim, wantVp9, wantAudioOnly);
    const q = qs ? `?${qs}` : '';
    const host = req.headers.host || `${HOST}:${PORT}`;
    const hls = `http://${host}/hls/${vid}/index.m3u8${q}`;
    const download = `http://${host}/dl/${vid}${q}`;
    const meta = s.meta || {};
    const wantsJson = (req.headers.accept || '').includes('application/json');
    if (wantsJson) {
      return send(res, 200, JSON.stringify({
        id: vid, title: meta.title ?? vid, durationMs: meta.durationMs ?? 0,
        video: meta.video ?? null, audio: meta.audio ?? null, hls, download,
      }) + '\n', { 'Content-Type': 'application/json; charset=utf-8' });
    }
    const codecs = meta.video ? `${meta.video} + ${meta.audio}` : `audio-only · ${meta.audio}`;
    const body = `${meta.title ?? vid}\n`
      + `${fmtDuration(meta.durationMs)} · ${codecs}\n`
      + `hls:      ${hls}\n`
      + `download: ${download}\n`;
    return send(res, 200, body, { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  // GET /dl/<id>[?from=&to=][&x=1][&vp9=1]  — download the clip (or full video,
  // or audio-only) as one file. Reuses the playback session's segments.
  if (parts[0] === 'dl' && parts.length === 2) {
    const vid = parts[1];
    if (!VID_RE.test(vid)) return send(res, 400, 'bad video id\n', { 'Content-Type': 'text/plain' });
    const s = ensureSession(vid, trim, wantVp9, wantAudioOnly);
    try {
      await s.ready;
      // A full (untrimmed) session's playlist grows until the whole video is
      // pulled and ffmpeg writes ENDLIST — the download needs the finished file.
      if (!trim) await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('download timed out waiting for the full stream')),
          DOWNLOAD_FULL_WAIT_MS);
        s.finished.finally(() => { clearTimeout(timer); resolve(); });
      });
      const file = await ensureDownloadFile(s);
      const ext = s.audioOnly ? 'm4a' : 'mp4';
      const ct = s.audioOnly ? 'audio/mp4' : 'video/mp4';
      return serveDownload(res, file, ct, downloadName(s, trim, ext));
    } catch (e) {
      return send(res, 502, `failed: ${e?.message ?? e}\n`, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  }

  // GET /hls/<id>/<file>[?from=&to=][&x=1][&vp9=1]  — playlist or segment.
  if (parts[0] === 'hls' && parts.length === 3) {
    const vid = parts[1], file = parts[2];
    if (!VID_RE.test(vid) || !/^[A-Za-z0-9_.-]+$/.test(file)) {
      return send(res, 400, 'bad request\n', { 'Content-Type': 'text/plain' });
    }
    const s = ensureSession(vid, trim, wantVp9, wantAudioOnly);
    const qs = sessionQuery(trim, wantVp9, wantAudioOnly);
    if (file === 'index.m3u8') {
      try { await s.ready; }
      catch (e) { return send(res, 502, `failed: ${e?.message ?? e}\n`, { 'Content-Type': 'text/plain; charset=utf-8' }); }
      if (qs) {
        // Graft ?from&to(&vp9) onto every segment + init URI so the player keeps
        // the query and each fetch routes back to this session (relative URI
        // resolution otherwise drops the parent query).
        const raw = await fs.promises.readFile(path.join(s.dir, 'index.m3u8'), 'utf8');
        const out = raw
          .replace(/^([^#\r\n][^\r\n]*\.(?:ts|m4s))\s*$/gm, `$1?${qs}`)
          .replace(/#EXT-X-MAP:URI="([^"]+)"/g, `#EXT-X-MAP:URI="$1?${qs}"`);
        return send(res, 200, out, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      }
      return serveFile(res, path.join(s.dir, 'index.m3u8'), 'application/vnd.apple.mpegurl');
    }
    if (file.endsWith('.ts') || file.endsWith('.m4s') || file.endsWith('.mp4')) {
      // Trimmed / vp9 / audio-only sessions are built lazily — wait for the
      // segment files to exist. (download.mp4/m4a is served via /dl, not here.)
      if (trim || wantVp9 || wantAudioOnly) {
        try { await s.ready; }
        catch (e) { return send(res, 502, `failed: ${e?.message ?? e}\n`, { 'Content-Type': 'text/plain; charset=utf-8' }); }
      }
      const ct = file.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';
      return serveFile(res, path.join(s.dir, file), ct);
    }
    return send(res, 404, 'not found\n', { 'Content-Type': 'text/plain' });
  }

  return send(res, 404, 'not found\n', { 'Content-Type': 'text/plain' });
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`try: curl http://${HOST}:${PORT}/play/gofCdGw1VGA`);
});

async function shutdown() {
  log('shutting down…');
  await Promise.all([...sessions.keys()].map((v) => stopSession(v)));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
