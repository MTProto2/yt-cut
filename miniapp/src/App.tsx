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

const VIDEO_ID_RE = /(?:youtu\.be\/|youtube\.com\/watch\?v=|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/

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
function clipStreamUrl(videoId: string, start: number, end: number, audio: boolean): string {
  const p = new URLSearchParams()
  if (start || end) {
    p.set('from', String(start))
    if (end) p.set('to', String(end))
  }
  if (audio) p.set('x', '1')
  const qs = p.toString()
  return `${YT_HLS_URL}/hls/${videoId}/index.m3u8${qs ? `?${qs}` : ''}`
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
      const match = VIDEO_ID_RE.exec(trimmed)
      if (!match) {
        setMeta(null)
        setError('Invalid YouTube URL')
        setLoading(false)
        return
      }
      try {
        const r = await fetch(`${YT_HLS_URL}/play/${match[1]}`, {
          headers: { Accept: 'application/json' },
        })
        if (!r.ok) {
          // yt-hls returns plain text (not JSON) on error, even with Accept: application/json.
          const text = (await r.text()).replace(/^failed:\s*/, '').trim()
          setMeta(null)
          setError(text || 'Не удалось получить видео')
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
        }
      } catch {
        setMeta(null)
        setError('Сетевая ошибка')
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

  // MainButton wiring (Telegram only)
  useEffect(() => {
    if (!inTelegram || !tg?.MainButton) return
    tg.MainButton.setText('Поделиться')
    if (meta) {
      tg.MainButton.show()
      tg.MainButton.onClick(onShare)
      return () => tg.MainButton.offClick(onShare)
    } else {
      tg.MainButton.hide()
    }
  }, [meta, onShare])

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
          <button
            type="button"
            onClick={onBrowserShare}
            style={{
              width: '100%',
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
            Поделиться
          </button>
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
