import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowRight, ArrowUpRight, Check, ChevronDown, Disc3, Download, Heart, Headphones, Library, ListMusic, LogOut, Music2, Plus, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { GENRE_LABELS, LANGUAGE_LABELS } from '../lib/arrange'
import type { EnrichedTrack, HistoryData, ListeningLevel, PlaylistGroup, StoredLibrary } from '../types'

type GroupMode = NonNullable<StoredLibrary['groupMode']>

interface Props {
  tracks: EnrichedTrack[]
  groups: PlaylistGroup[]
  history: HistoryData | null
  source: 'demo' | 'spotify'
  connected: boolean
  busy: string | null
  notice: string | null
  onConnect: () => void
  onConnectionSettings?: () => void
  onArrange?: () => void
  groupMode?: GroupMode
  onGroupModeChange?: (mode: GroupMode) => void
  onBatchCreate?: (groups: PlaylistGroup[]) => void
  onLanguageTag?: (ids: string[], language: string) => void
  allowDemo?: boolean
  onImport: (file: File) => void
  onResetDemo: () => void
  onDisconnect: () => void
  onRemove: (tracks: EnrichedTrack[]) => void
  onCreatePlaylist: (group: PlaylistGroup) => void
  onTag: (ids: string[], genre: string) => void
  onExport: () => void
  onRefresh: () => void
}

type Page = 'library' | 'groups' | 'cleanup'
type Filter = ListeningLevel | 'all'
type Sort = 'added' | 'recent' | 'oldest' | 'low' | 'high'
const levels: Record<ListeningLevel, { label: string; className: string }> = {
  heavy: { label: 'Nghe nhiều', className: 'heavy' },
  regular: { label: 'Bình thường', className: 'regular' },
  light: { label: 'Ít nghe', className: 'light' },
  unknown: { label: 'Chưa ghi nhận', className: 'unknown' },
}
const genreOptions = ['Indie Việt', 'R&B / Soul', 'Pop', 'Alternative', 'Hip-hop / Rap', 'Electronic', 'Jazz', 'Rock', 'Acoustic', 'Nhạc Việt', ...GENRE_LABELS]
const pageNames: Record<Page, string> = { library: 'Thư viện của bạn', groups: 'Nhóm theo gu', cleanup: 'Dọn thư viện' }
const groupBasisLabel = (group: PlaylistGroup) => group.basis === 'genre' ? 'Thể loại' : group.basis === 'language' ? 'Ngôn ngữ' : group.basis === 'genre-language' ? 'Thể loại + ngôn ngữ' : group.basis === 'history' ? 'Thói quen nghe' : 'Cùng nghệ sĩ'
const sourceLabel = { manual: 'Đã chỉnh tay', catalog: 'Nhãn nghệ sĩ', heuristic: 'Suy đoán', ai: 'AI gợi ý' }
const date = (value: string | null) => value ? new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(value)) : '—'
const duration = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`

function AlbumCover({ track, small = false }: { track: EnrichedTrack; small?: boolean }) {
  return <div className={`album-cover ${small ? 'small' : ''}`} style={{ '--art-color': track.color || '#b78ac4' } as CSSProperties}>
    {track.artwork ? <img src={track.artwork} alt="" loading="lazy" /> : <><span className="cover-shape" /><span className="cover-ring" /></>}
  </div>
}

function GroupArtwork({ group, index }: { group: PlaylistGroup; index: number }) {
  return <div aria-hidden="true" className={`playlist-art art-${index % 4}`} style={{ '--art-color': group.color || '#b499ce' } as CSSProperties}>
    <span className="art-orbit" /><span className="art-orbit second" /><span className="art-disc" />
    <span className="art-word">{index % 4 === 0 ? 'in a\ngood mood' : index % 4 === 1 ? 'slow\nsounds' : index % 4 === 2 ? 'on\nrepeat' : 'a little\ndifferent'}</span>
    <span className="art-symbol"><Music2 size={16} /></span>
  </div>
}

export default function LibraryView({ tracks, groups, history, source, connected, busy, notice, onConnect, onConnectionSettings, onArrange, groupMode = 'taste', onGroupModeChange, onBatchCreate, onLanguageTag, allowDemo = false, onImport, onResetDemo, onDisconnect, onRemove, onCreatePlaylist, onTag, onExport, onRefresh }: Props) {
  const [page, setPage] = useState<Page>('library')
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('added')
  const [rowPage, setRowPage] = useState(0)
  const [groupPage, setGroupPage] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [tag, setTag] = useState('')
  const [languageTag, setLanguageTag] = useState('')
  const importInput = useRef<HTMLInputElement>(null)
  const selectAll = useRef<HTMLInputElement>(null)

  useEffect(() => { setSelected(new Set()); setTag(''); setLanguageTag('') }, [page, filter, query, sort, tracks, rowPage])
  useEffect(() => { setRowPage(0) }, [page, filter, query, sort, tracks])
  useEffect(() => { setGroupPage(0) }, [groups, page])

  const counts = useMemo(() => tracks.reduce((acc, track) => { acc[track.listening] += 1; return acc }, { heavy: 0, regular: 0, light: 0, unknown: 0 }), [tracks])
  const matched = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('vi')
    const rows = tracks.filter(track => (!normalizedQuery || `${track.title} ${track.artist} ${track.genre || ''}`.toLocaleLowerCase('vi').includes(normalizedQuery)) && (filter === 'all' || track.listening === filter) && (page !== 'cleanup' || track.listening === 'light' || track.listening === 'unknown'))
    return rows.sort((a, b) => {
      if (sort === 'low' || sort === 'high') {
        if (a.hasHistory !== b.hasHistory) return a.hasHistory ? -1 : 1
        return sort === 'low' ? a.plays - b.plays : b.plays - a.plays
      }
      if (sort === 'recent' || sort === 'oldest') {
        if (Boolean(a.lastPlayed) !== Boolean(b.lastPlayed)) return a.lastPlayed ? -1 : 1
        return sort === 'recent' ? (b.lastPlayed || '').localeCompare(a.lastPlayed || '') : (a.lastPlayed || '').localeCompare(b.lastPlayed || '')
      }
      return b.addedAt.localeCompare(a.addedAt)
    })
  }, [tracks, query, filter, page, sort])

  const pageSize = 50
  const pageCount = Math.max(1, Math.ceil(matched.length / pageSize))
  const visible = useMemo(() => matched.slice(rowPage * pageSize, (rowPage + 1) * pageSize), [matched, rowPage])
  const groupPageSize = 24
  const groupPageCount = Math.max(1, Math.ceil(groups.length / groupPageSize))
  const visibleGroups = page === 'groups' ? groups.slice(groupPage * groupPageSize, (groupPage + 1) * groupPageSize) : groups.slice(0, 4)

  const selectedTracks = tracks.filter(track => selected.has(track.id))
  const allSelected = visible.length > 0 && visible.every(track => selected.has(track.id))
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = selected.size > 0 && !allSelected }, [selected, allSelected])
  const toggle = (id: string) => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const changePage = (next: Page) => { setPage(next); setFilter('all'); setQuery('') }
  const arrangeLibrary = () => { changePage('groups'); onArrange?.() }
  const importHistory = () => importInput.current?.click()
  const reviewCount = counts.light + counts.unknown
  const historyNote = history ? `${history.source === 'demo' ? 'Lịch sử mẫu' : history.source === 'spotify-recent' ? 'Lịch sử gần đây từ Spotify' : 'Lịch sử đã nhập'}${history.from && history.to ? ` · ${date(history.from)} – ${date(history.to)}` : ''}` : 'Chưa có lịch sử nghe. Nhập dữ liệu để phân loại chính xác hơn.'

  return <div className="app-shell">
    <input className="visually-hidden" type="file" accept=".json,application/json" ref={importInput} aria-label="Nhập tệp JSON lịch sử nghe Spotify" onChange={event => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = '' }} />
    <aside className="sidebar">
      <button className="brand" onClick={() => changePage('library')} aria-label="sóng — về thư viện"><span className="brand-wave"><i /><i /><i /><i /><i /></span>sóng<span className="brand-dot">.</span></button>
      <div className="sidebar-caption">KHÔNG GIAN ÂM NHẠC</div>
      <nav className="main-nav" aria-label="Điều hướng chính">
        <button className={page === 'library' ? 'active' : ''} onClick={() => changePage('library')}><Library size={18} />Thư viện của bạn<span className="nav-dot" /></button>
        <button className={page === 'groups' ? 'active' : ''} onClick={() => changePage('groups')}><ListMusic size={18} />Nhóm theo gu<span className="nav-count">{groups.length}</span></button>
        <button className={page === 'cleanup' ? 'active' : ''} onClick={() => changePage('cleanup')}><Trash2 size={18} />Dọn thư viện</button>
      </nav>
      <div className="sidebar-mini-card"><span className="mini-icon"><Headphones size={19} /></span><strong>Nhạc hay, đúng chỗ.</strong><p>Để mỗi lần mở Spotify đều tìm thấy bài bạn muốn nghe.</p><button onClick={importHistory} disabled={Boolean(busy)}>Nhập lịch sử nghe <ArrowUpRight size={14} /></button></div>
      <div className="sidebar-bottom">
        <div className="privacy-note"><ShieldCheck size={15} /><span>Dữ liệu lưu trên trình duyệt</span></div>
        <div className="connection-card"><span className={`connection-icon ${connected ? 'online' : ''}`}><Music2 size={19} /></span><span><strong>{connected ? 'Đã kết nối Spotify' : 'Spotify của bạn'}</strong><small>{connected ? 'Sẵn sàng đồng bộ' : 'Kết nối khi bạn sẵn sàng'}</small></span>{connected && <button className="icon-button" onClick={onDisconnect} disabled={Boolean(busy)} aria-label="Ngắt kết nối Spotify" title="Ngắt kết nối"><LogOut size={15} /></button>}</div>
        {allowDemo && source !== 'demo' && <button className="demo-reset" disabled={Boolean(busy)} onClick={onResetDemo}>Mở thư viện mẫu</button>}
      </div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div className="breadcrumbs"><span>Không gian của bạn</span><span className="breadcrumb-slash">/</span><strong>{pageNames[page]}</strong></div><div className="topbar-actions">{allowDemo && source === 'demo' && <span className="demo-badge"><span />Dữ liệu mẫu</span>}{onConnectionSettings && <button className="icon-button" disabled={Boolean(busy)} onClick={onConnectionSettings} title="Cài đặt kết nối Spotify" aria-label="Cài đặt kết nối Spotify"><Settings2 size={17} /></button>}<button className="icon-button export-button" onClick={onExport} title="Xuất thư viện và nhóm nhạc" aria-label="Xuất thư viện và nhóm nhạc"><Download size={18} /></button><span className="user-avatar">bạn</span></div></header>

      {notice && <div className="notice-banner" role="status"><Check size={17} /><span>{notice}</span></div>}

      {page === 'library' ? <section className="hero">
        <div className="hero-copy"><div className="eyebrow"><span />MỘT CHÚT SẮP XẾP. NHIỀU HƠN CẢM HỨNG.</div><h1>Thư viện gọn hơn.<br /><span>Nhạc vẫn đúng gu.</span></h1><p>Gom những bài cùng gu thành playlist. Tìm lại bài bạn yêu,<br className="desktop-break" /> và nhẹ nhàng bỏ bớt những bài đã lâu không nghe.</p><div className="hero-actions">{tracks.length > 0 && onArrange && <button className="button primary" disabled={Boolean(busy)} onClick={arrangeLibrary}><Sparkles size={17} />Tự động sắp xếp</button>}<button className={tracks.length > 0 ? 'button secondary' : 'button primary'} disabled={Boolean(busy)} onClick={connected ? onRefresh : onConnect}>{connected ? <RefreshCw size={17} /> : <Music2 size={18} />}{connected ? 'Đồng bộ Spotify' : 'Đăng nhập Spotify'}<ArrowUpRight size={16} /></button><button className="button secondary" disabled={Boolean(busy)} onClick={importHistory}><Upload size={16} />Nhập lịch sử nghe</button></div>{allowDemo && source === 'demo' && <span className="hero-footnote">Đang khám phá với thư viện mẫu. Kết nối để dùng nhạc của bạn.</span>}</div>
        <div className="hero-visual" aria-hidden="true"><div className="orbit-line orbit-one" /><div className="orbit-line orbit-two" /><div className="hero-album"><span className="album-label">your own<br /><b>little universe.</b></span><div className="vinyl"><span className="vinyl-label"><span className="vinyl-hole" /></span></div><span className="hero-album-mark">sóng.</span></div><span className="floating-tag tag-indie"><span />Indie Việt</span><span className="floating-tag tag-rnb"><span />R&B / Soul</span><span className="floating-star">✳</span></div>
      </section> : <section className="page-intro"><div className="eyebrow">{page === 'groups' ? 'MỖI GU NHẠC, MỘT GÓC RIÊNG' : 'DỌN MỘT CHÚT, NGHE VUI HƠN'}</div><h1>{page === 'groups' ? 'Nhạc cùng gu, về cùng chỗ.' : 'Giữ lại những bài bạn yêu.'}</h1><p>{page === 'groups' ? 'Tự động gom theo thể loại và ngôn ngữ, hoặc theo thói quen nghe. Xem lại nhãn gợi ý trước khi tạo playlist.' : 'Xem các bài ít nghe và chưa ghi nhận trong lịch sử. Bạn luôn chọn và xác nhận trước khi bỏ thích.'}</p>{page === 'groups' && onArrange && <button className="button primary groups-arrange" disabled={Boolean(busy) || !tracks.length} onClick={arrangeLibrary}><Sparkles size={16} />Tự động sắp xếp</button>}</section>}

      <section className="stats-grid" aria-label="Tổng quan thư viện">
        <div className="stat-card"><span className="stat-icon lime"><Heart size={19} /></span><div className="stat-copy"><span>Bài hát đã thích</span><strong>{tracks.length.toLocaleString('vi-VN')}<small>bài hát</small></strong></div><span className="stat-detail">Thư viện của bạn</span></div>
        <div className="stat-card"><span className="stat-icon purple"><ListMusic size={20} /></span><div className="stat-copy"><span>Nhóm cùng gu</span><strong>{groups.length}<small>nhóm nhạc</small></strong></div><button className="stat-link" onClick={() => changePage('groups')} aria-label="Xem các nhóm cùng gu"><ArrowUpRight size={18} /></button></div>
        <div className="stat-card"><span className="stat-icon peach"><Disc3 size={20} /></span><div className="stat-copy"><span>Có thể xem lại</span><strong>{reviewCount}<small>bài hát</small></strong></div><span className="stat-detail">Ít nghe + chưa ghi nhận</span></div>
      </section>

      {page !== 'cleanup' && <section className={`suggestions ${page === 'groups' ? 'expanded' : ''}`}>
        {page === 'groups' && <div className="groups-toolbar">{onGroupModeChange && <label>Gom theo<select value={groupMode} disabled={Boolean(busy)} onChange={event => onGroupModeChange(event.target.value as GroupMode)} aria-label="Cách gom nhóm playlist"><option value="taste">Thói quen nghe / nghệ sĩ</option><option value="genre-language">Thể loại + ngôn ngữ</option><option value="genre">Thể loại</option><option value="language">Ngôn ngữ</option></select><ChevronDown size={13} /></label>}{onBatchCreate && <button className="button secondary" disabled={Boolean(busy) || !groups.length} onClick={() => onBatchCreate(groups)}><ListMusic size={16} />Tạo nhiều playlist</button>}</div>}
        <div className="section-heading"><div><h2>{page === 'groups' ? 'Các nhóm trong thư viện' : 'Cùng gu, cùng playlist'}<span className="soft-pill">Gợi ý cho bạn</span></h2><p>{groupMode !== 'taste' ? 'Gợi ý từ thông tin bài hát. Kiểm tra và chỉnh nhãn trước khi tạo playlist.' : groups.some(group => group.basis === 'history') ? 'Từ thể loại, nghệ sĩ và những bài bạn thường nghe cùng nhau.' : groups.some(group => group.basis === 'genre') ? 'Từ thể loại bạn chọn và những nghệ sĩ bạn yêu thích.' : 'Bắt đầu từ nghệ sĩ. Gắn thể loại để gom nhạc theo gu của bạn.'}</p></div>{page === 'library' && <button className="text-button" onClick={() => changePage('groups')}>Xem tất cả<ArrowRight size={15} /></button>}</div>
        {groups.length ? <div className="playlist-grid">{visibleGroups.map((group, index) => <article className="playlist-card" key={group.id}><GroupArtwork group={group} index={index} /><div className="playlist-info"><div><h3>{group.name}</h3><p>{group.tracks.length} bài hát<span>·</span>{groupBasisLabel(group)}</p></div><button className="playlist-add" disabled={Boolean(busy)} onClick={() => onCreatePlaylist(group)} aria-label={`Tạo playlist ${group.name}`} title={`Tạo playlist ${group.name}`}><Plus size={18} /></button></div>{page === 'groups' && <><p className="group-description">{group.description}</p><div className="group-track-list">{group.tracks.slice(0, 3).map(track => <div className="group-track" key={track.id}><AlbumCover track={track} small /><span><strong>{track.title}</strong><small>{track.artist}</small></span></div>)}{group.tracks.length > 3 && <span className="more-tracks">Và {group.tracks.length - 3} bài hát khác</span>}</div><button className="button secondary group-create" disabled={Boolean(busy)} onClick={() => onCreatePlaylist(group)}><Plus size={15} />Tạo playlist</button></>}</article>)}</div> : <div className="empty-state compact"><ListMusic size={28} /><h3>Chưa có nhóm nhạc</h3><p>{tracks.length ? 'Thích thêm bài hát hoặc gắn thể loại cho các bài trong thư viện.' : 'Đăng nhập Spotify để đồng bộ Liked Songs và bắt đầu gom nhạc theo gu.'}</p></div>}
        {page === 'groups' && groups.length > 0 && <div className="table-footer"><span>Hiển thị {groupPage * groupPageSize + 1}–{Math.min((groupPage + 1) * groupPageSize, groups.length)} / {groups.length} nhóm nhạc</span>{groupPageCount > 1 && <nav className="pagination" aria-label="Phân trang nhóm nhạc"><button disabled={groupPage === 0 || Boolean(busy)} onClick={() => setGroupPage(current => current - 1)} aria-label="Trang nhóm trước">Trước</button><span>{groupPage + 1} / {groupPageCount}</span><button disabled={groupPage >= groupPageCount - 1 || Boolean(busy)} onClick={() => setGroupPage(current => current + 1)} aria-label="Trang nhóm sau">Sau</button></nav>}</div>}
      </section>}

      {page !== 'groups' && <section className="library-section">
        {page === 'cleanup' && <div className="cleanup-note"><Disc3 size={20} /><div><strong>Chưa ghi nhận không có nghĩa là bạn ít nghe.</strong><p>Lượt nghe chỉ tính trong dữ liệu đang có. Nhập lịch sử Spotify để có cái nhìn đầy đủ hơn.</p></div><button className="text-button" onClick={importHistory}>Nhập lịch sử<Upload size={15} /></button></div>}
        <div className="section-heading library-heading"><div><h2>{page === 'cleanup' ? 'Những bài có thể xem lại' : 'Nhạc trong thư viện'}<span className="number-pill">{page === 'cleanup' ? reviewCount : tracks.length}</span></h2><p>{historyNote}</p></div><label className="search-field"><Search size={16} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Tìm bài hát, nghệ sĩ..." aria-label="Tìm bài hát hoặc nghệ sĩ" /><span className="search-key">⌕</span></label></div>
        <div className="table-toolbar"><div className="filter-tabs" aria-label="Lọc theo mức độ nghe">{(['all', ...(page === 'cleanup' ? ['light', 'unknown'] : ['heavy', 'regular', 'light', 'unknown'])] as Filter[]).map(value => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)} aria-pressed={filter === value}>{value === 'all' ? 'Tất cả' : levels[value].label}<span>{value === 'all' ? (page === 'cleanup' ? reviewCount : tracks.length) : counts[value]}</span></button>)}</div><label className="sort-control"><SlidersHorizontal size={14} /><select value={sort} onChange={event => setSort(event.target.value as Sort)} aria-label="Sắp xếp bài hát"><option value="added">Mới thêm gần đây</option><option value="recent">Nghe gần đây nhất</option><option value="oldest">Lâu chưa nghe nhất</option><option value="low">Lượt nghe ít → nhiều</option><option value="high">Lượt nghe nhiều → ít</option></select><ChevronDown size={13} /></label></div>
        <div className="table-scroll"><table className="tracks-table"><thead><tr><th className="check-cell"><input ref={selectAll} type="checkbox" aria-label="Chọn tất cả các bài đang hiển thị" checked={allSelected} disabled={!visible.length || Boolean(busy)} onChange={() => setSelected(allSelected ? new Set() : new Set(visible.map(track => track.id)))} /></th><th className="index-cell">#</th><th className="track-cell">BÀI HÁT</th><th>THỂ LOẠI / NGÔN NGỮ</th><th>MỨC ĐỘ NGHE</th><th className="plays-cell">LƯỢT NGHE</th><th>NGHE GẦN NHẤT</th><th className="duration-cell" aria-label="Thời lượng"><Headphones size={14} /></th></tr></thead><tbody>{visible.map((track, index) => <tr key={track.id} className={selected.has(track.id) ? 'row-selected' : ''}><td className="check-cell"><input type="checkbox" aria-label={`Chọn ${track.title} của ${track.artist}`} checked={selected.has(track.id)} disabled={Boolean(busy)} onChange={() => toggle(track.id)} /></td><td className="index-cell">{String(rowPage * pageSize + index + 1).padStart(2, '0')}</td><td className="track-cell"><div className="track-details"><AlbumCover track={track} /><div className="track-name"><strong>{track.title}</strong><span>{track.artist}</span></div>{source === 'spotify' && /^[a-zA-Z0-9]{22}$/.test(track.id) && <a className="track-external" href={`https://open.spotify.com/track/${track.id}`} target="_blank" rel="noopener noreferrer" title={`Mở ${track.title} trên Spotify`} aria-label={`Mở ${track.title} trên Spotify`}><ArrowUpRight size={15} /></a>}</div></td><td><span className={`genre-label ${!track.genre ? 'untagged' : ''}`}>{track.genre || 'Chưa gắn nhãn'}</span>{track.language && <span className="track-language">{track.language}</span>}{track.classificationSource && <span className={`classification-label ${track.classificationSource}`} title={typeof track.classificationConfidence === 'number' ? `Độ tin cậy gợi ý: ${Math.round(track.classificationConfidence * 100)}%` : undefined}>{sourceLabel[track.classificationSource]}{track.manualLabels?.length && track.classificationSource !== 'manual' ? ' · có nhãn chỉnh tay' : ''}{typeof track.classificationConfidence === 'number' && track.classificationConfidence < .65 ? ' · cần xem lại' : ''}</span>}</td><td><span className={`listening-badge ${levels[track.listening].className}`}><span />{levels[track.listening].label}</span></td><td className="plays-cell"><span className="play-count">{track.hasHistory ? track.plays : '—'}</span></td><td className="last-played">{date(track.lastPlayed)}</td><td className="duration-cell">{duration(track.durationMs)}</td></tr>)}</tbody></table></div>
        {visible.length === 0 && <div className="empty-state"><Search size={30} /><h3>Chưa tìm thấy bài hát</h3><p>{query || filter !== 'all' ? 'Thử đổi từ khóa hoặc bộ lọc của bạn.' : page === 'cleanup' ? 'Thư viện hiện không có bài thuộc nhóm này.' : 'Đăng nhập Spotify để mang nhạc của bạn vào đây.'}</p>{(query || filter !== 'all') && <button className="button secondary" onClick={() => { setQuery(''); setFilter('all') }}>Xóa bộ lọc</button>}</div>}
        <div className="table-footer"><span>Hiển thị {matched.length ? rowPage * pageSize + 1 : 0}–{Math.min((rowPage + 1) * pageSize, matched.length)} / {matched.length} bài hát</span>{pageCount > 1 && <nav className="pagination" aria-label="Phân trang thư viện"><button disabled={rowPage === 0 || Boolean(busy)} onClick={() => setRowPage(current => current - 1)} aria-label="Trang trước">Trước</button><span>{rowPage + 1} / {pageCount}</span><button disabled={rowPage >= pageCount - 1 || Boolean(busy)} onClick={() => setRowPage(current => current + 1)} aria-label="Trang sau">Sau</button></nav>}<span><span className="footer-dot" />≥30 giây / lượt · chỉ trong dữ liệu đã nhập</span></div>
      </section>}

      <footer className="page-footer"><span className="tiny-brand">sóng.</span><span>Một góc nhỏ cho gu âm nhạc của bạn.</span><span>Được tạo để bạn nghe có chủ đích hơn.</span></footer>
    </main>

    {selected.size > 0 && <div className="bulk-bar" role="region" aria-label="Thao tác với các bài đã chọn"><span className="bulk-selected"><span className="bulk-check"><Check size={14} /></span>Đã chọn <strong>{selected.size} bài</strong></span><button className="bulk-clear" onClick={() => setSelected(new Set())} aria-label="Bỏ chọn tất cả"><X size={17} /></button><span className="bulk-divider" /><label className="bulk-tag"><select value={tag} onChange={event => setTag(event.target.value)} aria-label="Chọn thể loại để gắn nhãn"><option value="">Gắn thể loại...</option>{[...new Set([...genreOptions, ...tracks.map(track => track.genre).filter((genre): genre is string => Boolean(genre))])].map(genre => <option key={genre} value={genre}>{genre}</option>)}</select><ChevronDown size={14} /></label>{onLanguageTag && <label className="bulk-tag"><select value={languageTag} onChange={event => setLanguageTag(event.target.value)} aria-label="Chọn ngôn ngữ để gắn nhãn"><option value="">Gắn ngôn ngữ...</option>{LANGUAGE_LABELS.map(language => <option key={language} value={language}>{language}</option>)}</select><ChevronDown size={14} /></label>}<button className="button secondary bulk-tag-apply" disabled={(!tag && !languageTag) || Boolean(busy)} onClick={() => { const ids = Array.from(selected); if (tag) onTag(ids, tag); if (languageTag) onLanguageTag?.(ids, languageTag); setSelected(new Set()); setTag(''); setLanguageTag('') }}>Áp dụng</button><button className="button danger" disabled={Boolean(busy)} onClick={() => onRemove(selectedTracks)}><Trash2 size={16} />Bỏ thích {selected.size} bài</button></div>}
    {busy && <div className="busy-toast" role="status"><RefreshCw className="spin" size={15} />{busy}</div>}
  </div>
}
