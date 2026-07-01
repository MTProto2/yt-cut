import { useCallback, useEffect, useState } from 'react'
import {
  AppRoot,
  List,
  Section,
  Cell,
  Input,
  Image,
  Slider,
  Switch,
  Spinner,
} from '@telegram-apps/telegram-ui'

const tg = window.Telegram?.WebApp
const inTelegram = !!tg?.initData

const YT_HLS_URL = (import.meta.env.VITE_YT_HLS_URL || 'http://localhost:8730').replace(/\/$/, '')

// youtu.be/<id>, youtube.com/watch?...v=<id>, /embed/<id>, /shorts/<id>, /live/<id>, /v/<id>
const VIDEO_ID_RE =
  /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/))([a-zA-Z0-9_-]{11})/
const BARE_ID_RE = /^[a-zA-Z0-9_-]{11}$/

// Accepts a full YouTube URL (any of the forms above, with or without ?si=… etc.) or a bare 11-char id.
function extractVideoId(input: string): string | null {
  const s = input.trim()
  if (BARE_ID_RE.test(s)) return s
  return VIDEO_ID_RE.exec(s)?.[1] ?? null
}

// Native Telegram haptics (no-op outside Telegram or on old clients).
const haptic = (type: 'success' | 'warning' | 'error') =>
  tg?.HapticFeedback?.notificationOccurred(type)

interface Meta {
  video_id: string
  title: string
  duration: number
  thumbnail: string
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

// Mirrors yt-hls's own from/to/x=1 query scheme (server.mjs: parseTrim/sessionQuery).
function clipQuery(start: number, end: number, audio: boolean): string {
  const p = new URLSearchParams()
  if (start || end) {
    p.set('from', String(start))
    if (end) p.set('to', String(end))
  }
  if (audio) p.set('x', '1')
  const qs = p.toString()
  return qs ? `?${qs}` : ''
}

// HLS stream (for playback/sharing).
function clipStreamUrl(videoId: string, start: number, end: number, audio: boolean): string {
  return `${YT_HLS_URL}/hls/${videoId}/index.m3u8${clipQuery(start, end, audio)}`
}

// Single-file download (yt-hls /dl: remux -c copy, Content-Disposition: attachment → .mp4 / .m4a for x=1).
function clipDownloadUrl(videoId: string, start: number, end: number, audio: boolean): string {
  return `${YT_HLS_URL}/dl/${videoId}${clipQuery(start, end, audio)}`
}

const PasteIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
  </svg>
)

const ClearIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="15" y1="9" x2="9" y2="15" />
    <line x1="9" y1="9" x2="15" y2="15" />
  </svg>
)

export default function App() {
  const [url, setUrl] = useState('')
  const [meta, setMeta] = useState<Meta | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [range, setRange] = useState<[number, number]>([0, 0])
  const [audio, setAudio] = useState(false)
  const [customTitle, setCustomTitle] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    tg?.ready()
    tg?.expand()
  }, [])

  // Debounced metadata fetch on URL change — hits the yt-hls sidecar directly (CORS-open).
  useEffect(() => {
    const trimmed = url.trim()
    if (!trimmed) {
      setMeta(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    const timer = setTimeout(async () => {
      const videoId = extractVideoId(trimmed)
      if (!videoId) {
        setMeta(null)
        setError('Неверная ссылка на YouTube')
        setLoading(false)
        haptic('error')
        return
      }
      try {
        const r = await fetch(`${YT_HLS_URL}/play/${videoId}`, {
          headers: { Accept: 'application/json' },
        })
        if (!r.ok) {
          // yt-hls returns plain text (not JSON) on error, even with Accept: application/json.
          const text = (await r.text()).replace(/^failed:\s*/, '').trim()
          setMeta(null)
          setError(text || 'Не удалось получить видео')
          haptic('error')
        } else {
          const data = await r.json()
          const duration = Math.round((data.durationMs || 0) / 1000)
          setMeta({
            video_id: data.id,
            title: data.title || data.id,
            duration,
            thumbnail: `https://img.youtube.com/vi/${data.id}/maxresdefault.jpg`,
          })
          setRange([0, duration])
          haptic('success')
        }
      } catch {
        setMeta(null)
        setError('Сетевая ошибка')
        haptic('error')
      } finally {
        setLoading(false)
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [url])

  const handlePaste = useCallback(async () => {
    try {
      if (navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText()
        if (text) {
          setUrl(text)
          return
        }
      }
    } catch {
      // permission denied or not in secure context — fall through
    }
    const anyTg = tg as any
    if (inTelegram && anyTg?.readTextFromClipboard) {
      anyTg.readTextFromClipboard((text: string | null) => {
        if (text) setUrl(text)
      })
      return
    }
    setToast('Вставьте ссылку вручную')
    setTimeout(() => setToast(null), 2000)
  }, [])

  const onShare = useCallback(async () => {
    if (!meta || !tg) return
    tg.MainButton.showProgress()
    try {
      const start = Math.round(range[0])
      const end = Math.round(range[1])
      const clipEnd = end >= meta.duration ? 0 : end
      const r = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          init_data: tg.initData,
          title: customTitle.trim() || meta.title,
          original_title: meta.title,
          clip_url: clipStreamUrl(meta.video_id, start, clipEnd, audio),
          source_url: `https://www.youtube.com/watch?v=${meta.video_id}`,
          thumbnail: meta.thumbnail,
        }),
      })
      const data = await r.json()
      if (!r.ok || !data.prepared_message_id) {
        tg.showAlert(data.error || 'Не удалось подготовить сообщение')
        return
      }
      tg.shareMessage(data.prepared_message_id)
    } catch {
      tg.showAlert('Сетевая ошибка')
    } finally {
      tg.MainButton.hideProgress()
    }
  }, [meta, range, audio, customTitle])

  const onDownload = useCallback(() => {
    if (!meta) return
    const start = Math.round(range[0])
    const end = Math.round(range[1])
    const clipEnd = end >= meta.duration ? 0 : end
    const url = clipDownloadUrl(meta.video_id, start, clipEnd, audio)
    if (inTelegram && tg?.openLink) {
      // In-app WebView can't save files — hand the attachment link to the external browser.
      tg.openLink(url)
    } else {
      // Content-Disposition: attachment makes this a download, not a navigation.
      const a = document.createElement('a')
      a.href = url
      a.download = ''
      a.click()
    }
  }, [meta, range, audio])

  // MainButton wiring (Telegram only)
  useEffect(() => {
    if (!inTelegram || !tg?.MainButton) return
    tg.MainButton.setText('📤 Поделиться')
    if (meta) {
      tg.MainButton.show()
      tg.MainButton.onClick(onShare)
      return () => tg.MainButton.offClick(onShare)
    } else {
      tg.MainButton.hide()
    }
  }, [meta, onShare])

  // SecondaryButton wiring (Telegram only, Bot API 7.10+)
  useEffect(() => {
    const btn = tg?.SecondaryButton
    if (!inTelegram || !btn) return
    btn.setText('📥 Скачать')
    if (meta) {
      btn.show()
      btn.onClick(onDownload)
      return () => btn.offClick(onDownload)
    } else {
      btn.hide()
    }
  }, [meta, onDownload])

  const onBrowserShare = useCallback(async () => {
    if (!meta) return
    const start = Math.round(range[0])
    const end = Math.round(range[1])
    const clipEnd = end >= meta.duration ? 0 : end
    const clipUrl = clipStreamUrl(meta.video_id, start, clipEnd, audio)
    const title = customTitle.trim() || meta.title
    try {
      if (navigator.share) {
        await navigator.share({ title, url: clipUrl })
        return
      }
    } catch {
      return // user cancelled
    }
    try {
      await navigator.clipboard.writeText(clipUrl)
      setToast('Ссылка скопирована')
    } catch {
      setToast(clipUrl)
    }
    setTimeout(() => setToast(null), 2500)
  }, [meta, range, audio, customTitle])

  return (
    <AppRoot appearance={tg?.colorScheme}>
      <List style={{ padding: 0 }}>
        <Section>
          <Input
            placeholder="https://youtube.com/watch?v=..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            after={
              <button
                type="button"
                onClick={url ? () => setUrl('') : handlePaste}
                aria-label={url ? 'Очистить' : 'Вставить'}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 4,
                  margin: 0,
                  cursor: 'pointer',
                  color: 'var(--tgui--hint_color)',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                {url ? <ClearIcon /> : <PasteIcon />}
              </button>
            }
          />
        </Section>

        {loading && (
          <Cell before={<Spinner size="s" />}>Загрузка...</Cell>
        )}

        {error && !loading && (
          <Cell multiline>{error}</Cell>
        )}

        {meta && !loading && (
          <Section style={inTelegram ? undefined : { paddingBottom: 96 }}>
            <Cell before={<Image src={meta.thumbnail} size={40} />}>
              {meta.title}
            </Cell>
            <div style={{ padding: '4px 20px 8px' }}>
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--tgui--hint_color)',
                  marginBottom: 4,
                }}
              >
                {`Обрезка: ${fmt(range[0])} — ${fmt(range[1])}`}
              </div>
              <Slider
                multiple
                min={0}
                max={meta.duration}
                step={1}
                value={range}
                onChange={(v) => setRange([Math.round(v[0]), Math.round(v[1])])}
              />
            </div>
            <Input
              placeholder={`Заголовок (${meta.title})`}
              value={customTitle}
              onChange={(e) => setCustomTitle(e.target.value)}
            />
            <Cell
              Component="label"
              after={
                <Switch
                  checked={audio}
                  onChange={(e) => setAudio(e.target.checked)}
                />
              }
            >
              Только аудио
            </Cell>
          </Section>
        )}
      </List>

      {!inTelegram && meta && (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            padding: '12px 16px calc(12px + env(safe-area-inset-bottom))',
            background: 'var(--tgui--bg_color)',
            borderTop: '1px solid var(--tgui--divider)',
            zIndex: 10,
          }}
        >
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={onDownload}
              style={{
                flex: 1,
                padding: '14px 16px',
                border: 'none',
                borderRadius: 12,
                background: 'var(--tgui--secondary_bg_color, #efeff4)',
                color: 'var(--tgui--text_color, #000000)',
                fontSize: 16,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              📥 Скачать
            </button>
            <button
              type="button"
              onClick={onBrowserShare}
              style={{
                flex: 1,
                padding: '14px 16px',
                border: 'none',
                borderRadius: 12,
                background: 'var(--tgui--button_color, #3390ec)',
                color: 'var(--tgui--button_text_color, #ffffff)',
                fontSize: 16,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              📤 Поделиться
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div
          style={{
            position: 'fixed',
            left: '50%',
            bottom: inTelegram ? 24 : 96,
            transform: 'translateX(-50%)',
            padding: '10px 16px',
            background: 'rgba(0,0,0,0.8)',
            color: '#fff',
            borderRadius: 12,
            fontSize: 14,
            maxWidth: '90%',
            textAlign: 'center',
            zIndex: 20,
          }}
        >
          {toast}
        </div>
      )}
    </AppRoot>
  )
}
