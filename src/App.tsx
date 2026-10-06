import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Check, CheckCircle2, Download, ExternalLink, Info, ListMusic, LoaderCircle, Music2, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react'
import LibraryView from './components/LibraryView'
import { demoLibrary } from './lib/demo'
import { enrichTracks, groupTracks, mergeHistory, parseHistory } from './lib/library'
import { arrangedGroups, classifyTracks } from './lib/arrange'
import { beginSpotifyLogin, completeSpotifyLogin, createPlaylist, disconnectSpotify, fetchSpotifyGenreHints, fetchSpotifyLibrary, getSpotifyRedirectUri, hasSpotifySession, removeLikedTracks, SpotifyMutationError } from './lib/spotify'
import { readLibrary, writeLibrary } from './lib/storage'
import type { EnrichedTrack, PlaylistGroup, StoredLibrary, Track } from './types'

declare global {
  interface Window {
    songNativeExport?: (content: string, name: string) => void
  }
}

type GroupMode = NonNullable<StoredLibrary['groupMode']>
type Dialog = { kind: 'connect' } | { kind: 'remove'; tracks: EnrichedTrack[] } | { kind: 'playlist'; group: PlaylistGroup } | { kind: 'arrange' } | { kind: 'batch'; groups: PlaylistGroup[] } | { kind: 'demo' } | null
type BatchResult = { name: string; count: number; url?: string; status: 'created' | 'partial' | 'downloaded' }
const demoMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get('demo') === '1'
const emptyLibrary = (): StoredLibrary => ({ version: 1, source: 'spotify', tracks: [], history: null, genres: {} })
const groupModeLabels: Record<GroupMode, string> = { taste: 'Thói quen nghe / nghệ sĩ', genre: 'Thể loại', language: 'Ngôn ngữ', 'genre-language': 'Thể loại + ngôn ngữ' }
const basisLabel = (group: PlaylistGroup) => group.basis === 'genre' ? 'thể loại' : group.basis === 'language' ? 'ngôn ngữ' : group.basis === 'genre-language' ? 'thể loại và ngôn ngữ' : group.basis === 'history' ? 'thói quen nghe gần nhau' : 'nghệ sĩ'
const isUnknownGroup = (group: PlaylistGroup) => ['genre', 'language', 'genre-language'].includes(group.basis) && group.name.split(' · ').some(label => ['chưa rõ', 'chưa rõ thể loại', 'chưa xác định', 'không xác định', 'unknown'].includes(label.trim().toLocaleLowerCase('vi')))

function addManualLabel(track: Track, field: 'genre' | 'language'): Array<'genre' | 'language'> {
  const previous = track.manualLabels ?? (track.classificationSource === 'manual' ? [
    ...(track.genre && !/^chưa rõ/i.test(track.genre) ? ['genre' as const] : []),
    ...(track.language && !/^chưa rõ/i.test(track.language) ? ['language' as const] : []),
  ] : [])
  return [...new Set([...previous, field])]
}

function preserveClassification(fresh: Track[], previous: Track[]): Track[] {
  const old = new Map(previous.map(track => [track.id, track]))
  return fresh.map(track => {
    const saved = old.get(track.id)
    if (!saved) return track
    return { ...track, genre: saved.genre, language: saved.language, manualLabels: saved.manualLabels, classificationSource: saved.classificationSource, classificationConfidence: saved.classificationConfidence, artistGenres: track.artistGenres ?? saved.artistGenres }
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Có lỗi xảy ra. Bạn thử lại nhé.'
}

function downloadJson(value: unknown, name: string) {
  const content = JSON.stringify(value, null, 2)
  if (window.songNativeExport) { window.songNativeExport(content, name); return }
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Modal({ title, children, busy, onClose }: { title: string; children: ReactNode; busy: boolean; onClose: () => void }) {
  const element = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    element.current?.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled]), select:not([disabled]), a[href]')?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) close.current()
      if (event.key !== 'Tab') return
      const focusable = Array.from(element.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]') ?? [])
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || !element.current?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => {
      document.body.style.overflow = oldOverflow
      document.removeEventListener('keydown', keyboard)
      previous?.focus()
    }
  }, [busy])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={element}>
      <div className="modal-head"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label="Đóng" disabled={busy} onClick={onClose}><X size={20} /></button></div>
      {children}
    </div>
  </div>
}

export default function App() {
  const [library, setLibrary] = useState<StoredLibrary>(() => demoMode ? demoLibrary() : emptyLibrary())
  const [initialized, setInitialized] = useState(false)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState<string | null>('Đang mở thư viện…')
  const [notice, setNotice] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [error, setError] = useState<string | null>(null)
  const [clientId, setClientId] = useState(() => localStorage.getItem('song:spotify-client-id') || import.meta.env.VITE_SPOTIFY_CLIENT_ID || '')
  const [playlistName, setPlaylistName] = useState('')
  const [createdUrl, setCreatedUrl] = useState<string | null>(null)
  const [arrangeMode, setArrangeMode] = useState<GroupMode>('genre-language')
  const [classifyMode, setClassifyMode] = useState<'rules' | 'ai'>('rules')
  const [apiKey, setApiKey] = useState('')
  const [arrangeProgress, setArrangeProgress] = useState({ done: 0, total: 0, label: '' })
  const arrangeAbort = useRef<AbortController | null>(null)
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set())
  const [batchResults, setBatchResults] = useState<Record<string, BatchResult>>({})
  const [batchPage, setBatchPage] = useState(0)

  useEffect(() => () => arrangeAbort.current?.abort(), [])

  useEffect(() => {
    let mounted = true
    async function initialize() {
      let saved: StoredLibrary | null = null
      try {
        const cached = await readLibrary()
        saved = cached && (demoMode ? cached.source === 'demo' : cached.source === 'spotify') ? cached : null
        if (mounted && saved) setLibrary(saved)
      } catch { if (mounted) setNotice('Không đọc được bộ nhớ cục bộ. Đăng nhập Spotify để tải lại thư viện của bạn.') }
      try {
        const returned = await completeSpotifyLogin()
        if (!mounted) return
        setConnected(hasSpotifySession())
        if (returned) {
          setBusy('Đang đồng bộ Liked Songs…')
          const tracks = await fetchSpotifyLibrary(count => { if (mounted) setBusy(`Đã tải ${count} bài hát…`) })
          if (mounted) {
            setLibrary({ version: 1, source: 'spotify', tracks: preserveClassification(tracks, saved?.source === 'spotify' ? saved.tracks : []), history: saved?.source === 'spotify' ? saved.history : null, genres: saved?.source === 'spotify' ? saved.genres : {}, groupMode: saved?.source === 'spotify' ? saved.groupMode : 'taste' })
            setNotice(`Đã đồng bộ ${tracks.length} bài đã thích. Nhập lịch sử nghe để phân nhóm theo lượt nghe.`)
          }
        }
      } catch (cause) { if (mounted) setNotice(message(cause)) }
      finally { if (mounted) { setInitialized(true); setBusy(null) } }
    }
    void initialize()
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (!initialized) return
    void writeLibrary(library).catch(() => setNotice('Bộ nhớ trình duyệt đã đầy hoặc bị chặn. Dữ liệu hiện tại vẫn dùng được; hãy xuất thư viện để giữ một bản.'))
  }, [library, initialized])

  const tracks = useMemo(() => enrichTracks(library.tracks, library.history, library.genres), [library])
  const groupMode = library.groupMode ?? 'taste'
  const groups = useMemo(() => groupMode === 'taste' ? groupTracks(tracks, library.history) : arrangedGroups(tracks, groupMode), [tracks, library.history, groupMode])
  const closeDialog = () => { if (!busy) { setDialog(null); setError(null); setCreatedUrl(null); setApiKey('') } }
  const openConnect = () => { setError(null); setCreatedUrl(null); setDialog({ kind: 'connect' }) }
  const openArrange = () => { setError(null); setApiKey(''); setClassifyMode('rules'); setArrangeMode(groupMode === 'taste' ? 'genre-language' : groupMode); setArrangeProgress({ done: 0, total: 0, label: '' }); setDialog({ kind: 'arrange' }) }
  const openBatch = (candidates: PlaylistGroup[]) => { setError(null); setBatchResults({}); setBatchSelected(new Set(candidates.filter(group => !isUnknownGroup(group)).map(group => group.id))); setBatchPage(0); setDialog({ kind: 'batch', groups: candidates }) }
  const batchPending = dialog?.kind === 'batch' ? dialog.groups.filter(group => batchSelected.has(group.id) && !batchResults[group.id]) : []
  const batchPageSize = 24
  const batchPageCount = dialog?.kind === 'batch' ? Math.max(1, Math.ceil(dialog.groups.length / batchPageSize)) : 1

  async function login(fromSettings = false) {
    const configuredClientId = clientId.trim()
    if (!configuredClientId) { openConnect(); return }
    setError(null)
    setBusy('Đang mở đăng nhập Spotify…')
    try {
      await beginSpotifyLogin(configuredClientId)
    } catch (cause) {
      if (fromSettings) setError(message(cause))
      else setNotice(message(cause))
    } finally { setBusy(null) }
  }

  async function connect(event: FormEvent) {
    event.preventDefault()
    await login(true)
  }

  async function refresh() {
    if (!hasSpotifySession()) { setConnected(false); await login(); return }
    setBusy('Đang đồng bộ Liked Songs…')
    try {
      const fresh = await fetchSpotifyLibrary(count => setBusy(`Đã tải ${count} bài hát…`))
      setLibrary(previous => ({ version: 1, source: 'spotify', tracks: preserveClassification(fresh, previous.source === 'spotify' ? previous.tracks : []), history: previous.source === 'spotify' ? previous.history : null, genres: previous.genres, groupMode: previous.groupMode }))
      setNotice(`Đã cập nhật ${fresh.length} bài từ Spotify.`)
      setConnected(true)
    } catch (cause) { setNotice(message(cause)); setConnected(hasSpotifySession()) }
    finally { setBusy(null) }
  }

  async function importHistory(file: File) {
    setBusy('Đang đọc lịch sử nghe…')
    try {
      if (file.size > 100 * 1024 * 1024) throw new Error('File quá lớn (trên 100 MB). Hãy nhập từng file lịch sử nghe riêng.')
      const incoming = parseHistory(await file.text())
      setLibrary(previous => ({ ...previous, history: mergeHistory(previous.history?.source === 'demo' ? null : previous.history, incoming) }))
      setNotice(`Đã nhập ${incoming.events.length.toLocaleString('vi-VN')} lượt ghi nhận. Lượt nghe tính từ 30 giây; nhập tiếp file khác để bổ sung lịch sử.`)
    } catch (cause) { setNotice(message(cause)) }
    finally { setBusy(null) }
  }

  async function autoArrange(event: FormEvent) {
    event.preventDefault()
    if (busy || !library.tracks.length) return
    if (arrangeMode !== 'taste' && classifyMode === 'ai' && !apiKey.trim()) { setError('Nhập OpenAI API key hoặc chọn gợi ý nhanh không cần key.'); return }
    const controller = new AbortController()
    arrangeAbort.current = controller
    setError(null)
    setBusy('Đang tự động sắp xếp…')
    try {
      let candidates: Track[] = library.tracks.map(track => ({ ...track, genre: library.genres[track.id] ?? track.genre, manualLabels: library.source === 'spotify' && library.genres[track.id] ? addManualLabel(track, 'genre') : track.manualLabels, classificationSource: library.source === 'spotify' && library.genres[track.id] ? 'manual' as const : track.classificationSource }))
      if (arrangeMode !== 'taste' && library.source === 'spotify' && connected) {
        candidates = await fetchSpotifyGenreHints(candidates, { signal: controller.signal, onProgress: (done, total) => {
          setArrangeProgress({ done, total, label: 'Đang tìm nhãn thể loại từ Spotify' })
          setBusy(`Đang tìm thể loại nghệ sĩ · ${done}/${total}…`)
        } })
      }
      const classified = arrangeMode === 'taste' ? candidates : await classifyTracks(candidates, {
        mode: classifyMode,
        apiKey: classifyMode === 'ai' ? apiKey.trim() : undefined,
        signal: controller.signal,
        onProgress: (done, total) => {
          setArrangeProgress({ done, total, label: classifyMode === 'ai' ? 'AI đang gợi ý thể loại và ngôn ngữ' : 'Đang gợi ý thể loại và ngôn ngữ' })
          setBusy(`Đang phân loại · ${done}/${total} bài…`)
        },
      })
      if (controller.signal.aborted) throw new DOMException('Sắp xếp đã bị hủy.', 'AbortError')
      const manualIds = new Set(classified.filter(track => track.manualLabels?.includes('genre') || track.classificationSource === 'manual').map(track => track.id))
      setLibrary(previous => ({ ...previous, tracks: classified, groupMode: arrangeMode, genres: Object.fromEntries(Object.entries(previous.genres).filter(([id]) => manualIds.has(id))) }))
      setApiKey('')
      setDialog(null)
      setNotice(`Đã sắp xếp ${classified.length} bài theo ${groupModeLabels[arrangeMode].toLocaleLowerCase('vi')}. Xem lại nhóm “Chưa rõ” và các nhãn gợi ý trước khi tạo playlist.`)
    } catch (cause) {
      if (controller.signal.aborted) {
        setApiKey('')
        setDialog(null)
        setNotice('Đã hủy sắp xếp. Nhãn và playlist của bạn chưa thay đổi.')
      } else {
        setError(classifyMode === 'ai' ? 'Chưa sắp xếp được bằng AI. Kiểm tra API key, kết nối và hạn mức OpenAI API rồi thử lại. Nhãn hiện tại được giữ nguyên.' : message(cause))
      }
    } finally {
      arrangeAbort.current = null
      setBusy(null)
    }
  }

  async function confirmBatch(event: FormEvent) {
    event.preventDefault()
    if (dialog?.kind !== 'batch' || busy || !batchPending.length) return
    const pending = [...batchPending]
    setError(null)
    setBusy('Đang tạo các playlist đã chọn…')
    try {
      if (library.source === 'demo') {
        downloadJson({ source: 'demo', grouping: groupMode, playlists: pending.map(group => ({ name: group.name, basis: group.basis, tracks: group.tracks.map(({ title, artist, album, genre, language }) => ({ title, artist, album, genre, language })) })) }, 'song-nhom-playlist-mau.json')
        setBatchResults(previous => ({ ...previous, ...Object.fromEntries(pending.map(group => [group.id, { name: group.name, count: group.tracks.length, status: 'downloaded' as const }])) }))
        setNotice(`Đã tải ${pending.length} playlist mẫu. Spotify của bạn không thay đổi.`)
        return
      }
      for (const [index, group] of pending.entries()) {
        setBusy(`Đang tạo playlist ${index + 1}/${pending.length} · ${group.name}…`)
        try {
          const result = await createPlaylist(group.name.slice(0, 100), group.tracks.map(track => track.uri), `Sắp xếp bằng Sóng · ${basisLabel(group)}: ${group.name}`.slice(0, 300))
          setBatchResults(previous => ({ ...previous, [group.id]: { name: group.name, count: group.tracks.length, url: result.url, status: 'created' } }))
        } catch (cause) {
          const explanation = message(cause)
          const partialUrl = explanation.match(/https:\/\/open\.spotify\.com\/playlist\/[A-Za-z0-9]{22}/)?.[0]
          if (partialUrl) setBatchResults(previous => ({ ...previous, [group.id]: { name: group.name, count: group.tracks.length, url: partialUrl, status: 'partial' } }))
          setError(`${explanation} Các playlist đã tạo được giữ lại. Thử lại chỉ tiếp tục những nhóm chưa tạo; playlist tạo một phần cần kiểm tra riêng.`)
          setConnected(hasSpotifySession())
          return
        }
      }
      setNotice(`Đã tạo ${pending.length} playlist riêng tư. Liked Songs được giữ nguyên.`)
    } finally { setBusy(null) }
  }

  async function confirmRemove() {
    if (dialog?.kind !== 'remove') return
    const ids = [...new Set(dialog.tracks.map(track => track.id))].filter(id => library.tracks.some(track => track.id === id))
    setError(null)
    setBusy('Đang bỏ thích các bài đã chọn…')
    try {
      const removed = library.source === 'demo' ? ids : await removeLikedTracks(ids)
      setLibrary(previous => ({ ...previous, tracks: previous.tracks.filter(track => !removed.includes(track.id)) }))
      setNotice(library.source === 'demo' ? `Đã bỏ thích ${removed.length} bài trong bản mẫu. Spotify của bạn không thay đổi.` : `Đã bỏ thích ${removed.length} bài trên Spotify.`)
      setDialog(null)
    } catch (cause) {
      if (cause instanceof SpotifyMutationError && cause.completedIds.length) {
        setLibrary(previous => ({ ...previous, tracks: previous.tracks.filter(track => !cause.completedIds.includes(track.id)) }))
        setDialog(previous => previous?.kind === 'remove' ? { ...previous, tracks: previous.tracks.filter(track => !cause.completedIds.includes(track.id)) } : previous)
      }
      setError(message(cause))
      setConnected(hasSpotifySession())
    } finally { setBusy(null) }
  }

  async function confirmPlaylist(event: FormEvent) {
    event.preventDefault()
    if (dialog?.kind !== 'playlist') return
    const name = playlistName.trim()
    if (!name) { setError('Đặt tên cho playlist trước nhé.'); return }
    setError(null)
    setBusy('Đang tạo playlist…')
    try {
      if (library.source === 'demo') {
        downloadJson({ name, source: 'demo', tracks: dialog.group.tracks.map(({ title, artist, album, genre }) => ({ title, artist, album, genre })) }, 'song-playlist-mau.json')
        setNotice(`Đã tải playlist mẫu “${name}”. Kết nối Spotify để tạo playlist trong tài khoản của bạn.`)
        setDialog(null)
      } else {
        const description = `Sắp xếp bằng Sóng · ${basisLabel(dialog.group)}: ${dialog.group.name}`.slice(0, 300)
        const result = await createPlaylist(name, dialog.group.tracks.map(track => track.uri), description)
        setCreatedUrl(result.url)
        setNotice(`Đã tạo playlist riêng tư “${name}” với ${dialog.group.tracks.length} bài. Các bài vẫn được giữ trong Liked Songs.`)
      }
    } catch (cause) { setError(message(cause)); setConnected(hasSpotifySession()) }
    finally { setBusy(null) }
  }

  function resetDemo() {
    if (!demoMode) return
    setLibrary(demoLibrary())
    setDialog(null)
    setNotice('Đã làm mới dữ liệu mẫu. Các thay đổi trong bản mẫu không tác động tới Spotify.')
  }

  return <>
    <LibraryView tracks={tracks} groups={groups} history={library.history} source={library.source} connected={connected} busy={busy} notice={notice}
      onConnect={() => void login()} onConnectionSettings={openConnect} onImport={file => void importHistory(file)} allowDemo={demoMode}
      onArrange={openArrange} groupMode={groupMode} onGroupModeChange={mode => setLibrary(previous => ({ ...previous, groupMode: mode }))} onBatchCreate={openBatch}
      onResetDemo={() => { if (demoMode) { if (library.source === 'spotify') setDialog({ kind: 'demo' }); else resetDemo() } }}
      onDisconnect={() => { disconnectSpotify(); setConnected(false); setNotice('Đã ngắt kết nối. Dữ liệu đã đồng bộ còn trên trình duyệt để bạn xem và xuất.') }}
      onRefresh={() => void refresh()}
      onRemove={selected => { setError(null); setDialog({ kind: 'remove', tracks: selected }) }}
      onCreatePlaylist={group => { setError(null); setCreatedUrl(null); setPlaylistName(group.name.slice(0, 100)); setDialog({ kind: 'playlist', group }) }}
      onTag={(ids, genre) => setLibrary(previous => ({ ...previous, tracks: previous.tracks.map(track => ids.includes(track.id) ? { ...track, genre, manualLabels: addManualLabel(track, 'genre'), classificationSource: 'manual', classificationConfidence: undefined } : track), genres: { ...previous.genres, ...Object.fromEntries(ids.map(id => [id, genre])) } }))}
      onLanguageTag={(ids, language) => setLibrary(previous => ({ ...previous, tracks: previous.tracks.map(track => ids.includes(track.id) ? { ...track, language, manualLabels: addManualLabel(track, 'language'), classificationSource: 'manual', classificationConfidence: undefined } : track) }))}
      onExport={() => { downloadJson({ exportedAt: new Date().toISOString(), source: library.source, historyWindow: library.history ? { from: library.history.from, to: library.history.to } : null, tracks, groups: groups.map(group => ({ name: group.name, basis: group.basis, trackIds: group.tracks.map(track => track.id) })) }, 'song-thu-vien.json'); setNotice('Đã xuất thư viện và nhãn thể loại. File không chứa thông tin đăng nhập.') }}
    />

    {dialog?.kind === 'arrange' && <Modal title="Tự động sắp xếp thư viện" busy={!!busy} onClose={closeDialog}>
      <div className="dialog-intro"><span className="dialog-symbol"><Sparkles size={24} /></span><p>Gợi ý nhóm từ tên bài, nghệ sĩ, album và nhãn thể loại có sẵn. Bạn xem lại kết quả trước khi tạo playlist; nhãn đã chỉnh tay được giữ nguyên.</p></div>
      <form onSubmit={event => void autoArrange(event)}>
        <label className="form-field">Gom playlist theo<select value={arrangeMode} disabled={!!busy} onChange={event => setArrangeMode(event.target.value as GroupMode)}><option value="genre-language">Thể loại + ngôn ngữ (gợi ý)</option><option value="genre">Thể loại</option><option value="language">Ngôn ngữ</option><option value="taste">Thói quen nghe / nghệ sĩ</option></select></label>
        {arrangeMode !== 'taste' && <fieldset className="classify-method"><legend>Cách phân loại</legend><label className={`method-choice ${classifyMode === 'rules' ? 'selected' : ''}`}><input type="radio" name="classify-method" value="rules" checked={classifyMode === 'rules'} disabled={!!busy} onChange={() => { setClassifyMode('rules'); setApiKey('') }} /><span><strong>Gợi ý nhanh, không cần key</strong><small>Dùng thông tin có sẵn và quy tắc nhận diện. Không gửi thư viện sang OpenAI.</small></span></label><label className={`method-choice ${classifyMode === 'ai' ? 'selected' : ''}`}><input type="radio" name="classify-method" value="ai" checked={classifyMode === 'ai'} disabled={!!busy} onChange={() => setClassifyMode('ai')} /><span><strong>Gợi ý bằng ChatGPT / OpenAI</strong><small>Gửi tên bài, nghệ sĩ và album đến OpenAI để gợi ý nhãn.</small></span></label></fieldset>}
        {arrangeMode !== 'taste' && classifyMode === 'ai' && <><label className="form-field">OpenAI API key<input type="password" value={apiKey} disabled={!!busy} onChange={event => setApiKey(event.target.value)} placeholder="Chỉ dùng cho lần sắp xếp này" autoComplete="off" spellCheck={false} required /></label><p className="api-key-note"><ShieldCheck size={14} />Key chỉ giữ trong bộ nhớ của màn hình này và được xóa khi đóng. OpenAI API tính phí riêng; gói ChatGPT không cung cấp API key.</p></>}
        <div className="dialog-note"><Info size={17} /><div><strong>Nhãn là gợi ý, có thể chưa chính xác.</strong><small>Sóng không nghe âm thanh hoặc đọc lời bài hát. Thông tin chưa đủ sẽ vào nhóm “Chưa rõ”; bạn có thể sửa thể loại và ngôn ngữ sau.</small></div></div>
        {busy && <div className="arrange-progress" role="status"><div><span>{arrangeProgress.label || 'Đang chuẩn bị sắp xếp'}</span><strong>{arrangeProgress.done} / {arrangeProgress.total || library.tracks.length}</strong></div><progress max={arrangeProgress.total || library.tracks.length || 1} value={arrangeProgress.done} /></div>}
        {error && <p className="error-message" role="alert">{error}</p>}
        <div className="modal-actions">{busy ? <button type="button" className="button secondary" onClick={() => arrangeAbort.current?.abort()}>Hủy sắp xếp</button> : <><button type="button" className="button secondary" onClick={closeDialog}>Để sau</button><button type="submit" className="button primary" disabled={!library.tracks.length}><Sparkles size={16} />Sắp xếp {library.tracks.length} bài</button></>}</div>
      </form>
    </Modal>}

    {dialog?.kind === 'batch' && <Modal title="Tạo playlist từ các nhóm" busy={!!busy} onClose={closeDialog}>
      <div className="dialog-intro"><span className="dialog-symbol"><ListMusic size={25} /></span><p>Chọn các nhóm bạn muốn đưa lên Spotify. Mỗi nhóm tạo một playlist riêng tư; các bài vẫn nằm trong Liked Songs.</p></div>
      <form onSubmit={event => void confirmBatch(event)}>
        <div className="batch-choices"><strong>{batchSelected.size} / {dialog.groups.length} nhóm được chọn</strong><button type="button" disabled={!!busy} onClick={() => setBatchSelected(new Set(dialog.groups.filter(group => !isUnknownGroup(group) && !batchResults[group.id]).map(group => group.id)))}>Chọn nhóm đã xác định</button><button type="button" disabled={!!busy} onClick={() => setBatchSelected(new Set())}>Bỏ chọn tất cả</button></div>
        <div className="batch-list">{dialog.groups.slice(batchPage * batchPageSize, (batchPage + 1) * batchPageSize).map(group => {
          const result = batchResults[group.id]
          const uncertain = group.tracks.filter(track => (typeof track.classificationConfidence === 'number' && track.classificationConfidence < .65) || track.classificationSource === 'heuristic').length
          return <div className={`batch-group ${result ? 'completed' : ''}`} key={group.id}><label><input type="checkbox" aria-label={`Chọn playlist ${group.name}`} checked={batchSelected.has(group.id) || Boolean(result)} disabled={!!busy || Boolean(result)} onChange={() => setBatchSelected(previous => { const next = new Set(previous); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next })} /><span><strong>{group.name}</strong><small>{group.tracks.length} bài · {basisLabel(group)}{uncertain > 0 ? ` · ${uncertain} nhãn cần xem lại` : ''}</small><span className="batch-description">{group.description}</span>{isUnknownGroup(group) && <em>Thông tin chưa đủ · chưa chọn mặc định</em>}{result && <span className={`batch-result ${result.status === 'partial' ? 'partial' : ''}`}>{result.status === 'partial' ? 'Đã tạo một phần · kiểm tra trên Spotify' : result.status === 'downloaded' ? 'Đã tải bản mẫu' : 'Đã tạo trên Spotify'}</span>}</span></label>{result?.url && <a href={result.url} target="_blank" rel="noreferrer" aria-label={`Mở playlist ${group.name} trên Spotify`}><ExternalLink size={15} /></a>}</div>
        })}</div>
        {batchPageCount > 1 && <nav className="pagination batch-pagination" aria-label="Phân trang xem trước playlist"><button type="button" disabled={batchPage === 0 || !!busy} onClick={() => setBatchPage(current => current - 1)} aria-label="Trang playlist trước">Trước</button><span>{batchPage + 1} / {batchPageCount}</span><button type="button" disabled={batchPage >= batchPageCount - 1 || !!busy} onClick={() => setBatchPage(current => current + 1)} aria-label="Trang playlist sau">Sau</button></nav>}
        <div className="dialog-note"><Info size={17} /><div><small>Nhóm “Chưa rõ” cần xem lại và không được chọn mặc định. Nhãn suy đoán và AI chưa bảo đảm đúng thể loại hoặc ngôn ngữ. Bạn có thể chỉnh nhãn trước khi tạo.</small></div></div>
        {library.source === 'demo' && <p className="privacy-note">Bản mẫu tải danh sách dưới dạng JSON và không tạo playlist Spotify.</p>}
        {library.source === 'spotify' && !connected && <p className="error-message">Đăng nhập lại Spotify để tạo các playlist đã chọn.</p>}
        {error && <p className="error-message" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={closeDialog} disabled={!!busy}>{Object.keys(batchResults).length ? 'Xong' : 'Để sau'}</button><button type="submit" className="button primary" disabled={!!busy || !batchPending.length || (library.source === 'spotify' && !connected)}>{busy ? <LoaderCircle className="spin" size={16} /> : library.source === 'demo' ? <Download size={16} /> : <ListMusic size={16} />}{library.source === 'demo' ? `Tải ${batchPending.length} playlist mẫu` : `Tạo ${batchPending.length} playlist riêng tư`}</button></div>
      </form>
    </Modal>}

    {dialog?.kind === 'connect' && <Modal title="Kết nối Spotify của bạn" busy={!!busy} onClose={closeDialog}>
      <div className="dialog-intro"><span className="dialog-symbol"><Music2 size={26} /></span><p>Mang Liked Songs vào Sóng để sắp xếp và dọn thư viện theo gu của bạn.</p></div>
      <form onSubmit={event => void connect(event)}>
        <label className="form-field">Spotify Client ID<input value={clientId} onChange={event => setClientId(event.target.value)} placeholder="Client ID từ Spotify Developer Dashboard" required autoComplete="off" spellCheck={false} /></label>
        <div className="dialog-note"><Info size={17} /><div>Tạo app trong <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">Spotify Developer Dashboard <ExternalLink size={12} /></a>, rồi đăng ký Redirect URI chính xác:<code>{getSpotifyRedirectUri()}</code><small>Spotify yêu cầu HTTPS hoặc địa chỉ loopback 127.0.0.1 khi chạy ở máy cá nhân. Với app Development Mode, kiểm tra điều kiện tài khoản và thêm người dùng trong Dashboard.</small></div></div>
        <p className="privacy-note"><ShieldCheck size={15} /> Không cần Client Secret. Bạn cấp quyền đọc bài đã thích, tạo playlist riêng tư và bỏ thích bài đã chọn.</p>
        <p className="privacy-note">Thể loại và ngôn ngữ có thể gợi ý tự động rồi chỉnh lại; lịch sử nghe cần nhập riêng. Bạn có thể thu hồi quyền app trong tài khoản Spotify.</p>
        {error && <p className="error-message" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={closeDialog} disabled={!!busy}>Để sau</button><button type="submit" className="button primary" disabled={!!busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Music2 size={16} />} Tiếp tục với Spotify</button></div>
      </form>
    </Modal>}

    {dialog?.kind === 'remove' && <Modal title={`Bỏ thích ${dialog.tracks.length} bài hát?`} busy={!!busy} onClose={closeDialog}>
      <p className="dialog-description">{library.source === 'demo' ? 'Bạn đang thử với dữ liệu mẫu. Spotify của bạn không bị thay đổi.' : 'Các bài sau sẽ được gỡ khỏi Liked Songs của bạn trên Spotify. Chúng vẫn nằm trong các playlist khác.'}</p>
      <div className="selected-summary">{dialog.tracks.map(track => <div className="summary-track" key={track.id}><Music2 size={16} /><div><strong>{track.title}</strong><span>{track.artist}</span></div><Check size={15} /></div>)}</div>
      {library.source === 'spotify' && !connected && <p className="error-message">Kết nối lại Spotify để bỏ thích những bài này.</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="modal-actions"><button className="button secondary" onClick={closeDialog} disabled={!!busy}>Giữ lại</button><button className="button danger" onClick={() => void confirmRemove()} disabled={!!busy || (library.source === 'spotify' && !connected)}>{busy ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />} Bỏ thích {dialog.tracks.length} bài</button></div>
    </Modal>}

    {dialog?.kind === 'playlist' && <Modal title={createdUrl ? 'Playlist đã sẵn sàng' : 'Một góc riêng cho gu nhạc'} busy={!!busy} onClose={closeDialog}>
      {createdUrl ? <><div className="playlist-success"><CheckCircle2 size={48} /><h3>{playlistName}</h3><p>{dialog.group.tracks.length} bài hát · Playlist riêng tư</p></div><div className="modal-actions"><button className="button secondary" onClick={closeDialog}>Xong</button><a className="button primary" href={createdUrl} target="_blank" rel="noreferrer">Mở Spotify <ExternalLink size={16} /></a></div></> : <form onSubmit={event => void confirmPlaylist(event)}>
        <p className="dialog-description">{dialog.group.tracks.length} bài được gom theo {dialog.group.basis === 'genre' ? 'nhãn thể loại' : basisLabel(dialog.group)} “{dialog.group.name}”. Tạo playlist không làm mất các bài đã thích.</p>
        <label className="form-field">Tên playlist<input value={playlistName} onChange={event => setPlaylistName(event.target.value)} required maxLength={100} /></label>
        {library.source === 'demo' && <div className="dialog-note"><Info size={17} /><span>Bản mẫu sẽ tải danh sách bài hát dưới dạng JSON. Kết nối Spotify để tạo playlist thật.</span></div>}
        {library.source === 'spotify' && !connected && <p className="error-message">Kết nối lại Spotify để tạo playlist.</p>}
        {error && <p className="error-message" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={closeDialog} disabled={!!busy}>Để sau</button><button type="submit" className="button primary" disabled={!!busy || (library.source === 'spotify' && !connected)}>{busy ? <LoaderCircle size={16} className="spin" /> : library.source === 'demo' ? <Download size={16} /> : <Music2 size={16} />}{library.source === 'demo' ? 'Tải playlist mẫu' : 'Tạo playlist riêng tư'}</button></div>
      </form>}
    </Modal>}

    {demoMode && dialog?.kind === 'demo' && <Modal title="Chuyển sang dữ liệu mẫu?" busy={!!busy} onClose={closeDialog}><p className="dialog-description">Thư viện và lịch sử nghe đang lưu trong trình duyệt sẽ được thay bằng bản mẫu. Spotify của bạn không thay đổi. Bạn có thể xuất thư viện trước, hoặc đồng bộ Spotify lại sau.</p><div className="modal-actions"><button className="button secondary" onClick={closeDialog}>Giữ thư viện</button><button className="button primary" onClick={resetDemo}>Dùng bản mẫu</button></div></Modal>}
  </>
}
