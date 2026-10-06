import type { EnrichedTrack, HistoryData, HistoryEvent, PlaylistGroup, Track } from '../types'

const MIN_PLAY_MS = 30_000
const GROUP_COLORS = ['#c4cc8a', '#b6a4dc', '#d89aa9', '#81b5a4', '#d5b077', '#97b6ce']
const VI_SORT = new Intl.Collator('vi', { sensitivity: 'base' })
const SESSION_GAP_MS = 20 * 60_000
const MIN_SHARED_SESSIONS = 2
const MAX_HISTORY_ARTISTS = 4

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').trim().toLowerCase().replace(/\s+/g, ' ')
}

function nameKey(title: string, artist: string): string {
  return JSON.stringify([normalize(title), normalize(artist)])
}

function historyKey(event: HistoryEvent): string {
  return JSON.stringify([event.trackId ? `id:${event.trackId}` : `name:${nameKey(event.title, event.artist)}`, event.playedAt, event.msPlayed])
}

function namedPlayKey(event: HistoryEvent): string {
  return JSON.stringify([nameKey(event.title, event.artist), event.playedAt, event.msPlayed])
}

function uniqueEvents(events: HistoryEvent[]): HistoryEvent[] {
  const unique = new Map<string, HistoryEvent>()
  const identifiedNames = new Set<string>()
  for (const event of events) {
    const key = historyKey(event)
    if (!unique.has(key)) unique.set(key, event)
    if (event.trackId) identifiedNames.add(namedPlayKey(event))
  }
  // An ID-less classic row may also appear in an extended export. Keep the
  // identified row in that case, but never collapse two distinct known IDs.
  return [...unique.values()].filter((event) => event.trackId || !identifiedNames.has(namedPlayKey(event)))
    .sort((a, b) => a.playedAt.localeCompare(b.playedAt) || historyKey(a).localeCompare(historyKey(b)))
}

function historyData(events: HistoryEvent[], source: HistoryData['source']): HistoryData {
  const unique = uniqueEvents(events)
  return { events: unique, source, from: unique[0]?.playedAt ?? null, to: unique.at(-1)?.playedAt ?? null }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function spotifyTrackId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return /^spotify:track:([a-zA-Z0-9]+)$/.exec(value)?.[1]
}

interface TrackMatchIndex {
  byId: Map<string, Set<string>>
  byName: Map<string, Set<string>>
}

function trackMatchIndex(tracks: Track[]): TrackMatchIndex {
  const index: TrackMatchIndex = { byId: new Map(), byName: new Map() }
  const add = (map: Map<string, Set<string>>, key: string, id: string) => {
    const candidates = map.get(key) ?? new Set<string>()
    candidates.add(id)
    map.set(key, candidates)
  }
  for (const track of tracks) {
    add(index.byId, track.id, track.id)
    const uriId = spotifyTrackId(track.uri)
    if (uriId) add(index.byId, uriId, track.id)
    add(index.byName, nameKey(track.title, track.artist), track.id)
  }
  return index
}

function matchedTrackId(event: HistoryEvent, index: TrackMatchIndex): string | null {
  const candidates = event.trackId ? index.byId.get(event.trackId) : index.byName.get(nameKey(event.title, event.artist))
  return candidates?.size === 1 ? candidates.values().next().value ?? null : null
}

function groupColor(id: string): string {
  const index = [...id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % GROUP_COLORS.length
  return GROUP_COLORS[index]
}

// Classic exports contain UTC timestamps without a zone. Validate the calendar
// before parsing because JavaScript silently normalizes dates such as February 30.
function parseTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value.trim())
  if (!match) return null
  const [, year, month, day, hours, minutes, seconds = '00', fraction = '', zone = 'Z'] = match
  const [y, mo, d, h, m, s] = [year, month, day, hours, minutes, seconds].map(Number)
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || m > 59 || s > 59) return null
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  if (d > days) return null
  if (zone !== 'Z') {
    const offset = /[+-](\d{2}):?(\d{2})/.exec(zone)
    if (!offset || Number(offset[1]) > 23 || Number(offset[2]) > 59) return null
  }
  const milliseconds = fraction ? `.${fraction.slice(0, 3).padEnd(3, '0')}` : ''
  const parsed = Date.parse(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}${milliseconds}${zone}`)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/** Read Spotify's classic or extended streaming-history JSON exports. */
export function parseHistory(text: string): HistoryData {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Không đọc được JSON. Hãy chọn tệp StreamingHistory hoặc Streaming_History_Audio từ Spotify.')
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Tệp lịch sử phải là một mảng JSON xuất từ Spotify. Hãy chọn tệp lịch sử nghe nhạc, không phải tệp thông tin tài khoản.')
  }

  const events: HistoryEvent[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const extended = 'ts' in row || 'master_metadata_track_name' in row || 'spotify_track_uri' in row
    // Podcasts and audiobooks cannot safely be treated as music, even if an
    // export happens to contain some track-like metadata alongside them.
    if (row.episode_name || row.episode_show_name || row.audiobook_title || row.spotify_episode_uri) continue
    if (extended && typeof row.spotify_track_uri === 'string' && row.spotify_track_uri && !spotifyTrackId(row.spotify_track_uri)) continue
    const title = nonEmptyString(extended ? row.master_metadata_track_name : row.trackName)
    const artist = nonEmptyString(extended ? row.master_metadata_album_artist_name : row.artistName)
    const playedAt = parseTimestamp(extended ? row.ts : row.endTime)
    const msPlayed = extended ? row.ms_played : row.msPlayed
    if (!title || !artist || !playedAt || typeof msPlayed !== 'number' || !Number.isFinite(msPlayed) || msPlayed < 0) continue
    const trackId = extended ? spotifyTrackId(row.spotify_track_uri) : undefined
    events.push({ ...(trackId ? { trackId } : {}), title, artist, playedAt, msPlayed })
  }
  if (!events.length) {
    throw new Error('Không tìm thấy lượt nghe nhạc hợp lệ trong tệp. Podcast, bản ghi thiếu tên hoặc thời gian không hợp lệ được bỏ qua.')
  }
  return historyData(events, 'import')
}

/** Combine imports without counting an identical exported play twice. */
export function mergeHistory(existing: HistoryData | null, incoming: HistoryData): HistoryData {
  return historyData([...(existing?.events ?? []), ...incoming.events], incoming.source)
}

/** Use only observed plays of at least 30 seconds; absence is unknown. */
export function enrichTracks(tracks: Track[], history: HistoryData | null, genres: Record<string, string> = {}): EnrichedTrack[] {
  const index = trackMatchIndex(tracks)
  const byTrack = new Map<string, HistoryEvent[]>()
  for (const event of uniqueEvents(history?.events ?? [])) {
    if (!Number.isFinite(event.msPlayed) || event.msPlayed < MIN_PLAY_MS || !Number.isFinite(Date.parse(event.playedAt))) continue
    const id = matchedTrackId(event, index)
    if (!id) continue
    const items = byTrack.get(id) ?? []
    items.push(event)
    byTrack.set(id, items)
  }
  return tracks.map((track) => {
    const events = byTrack.get(track.id) ?? []
    const plays = events.length
    const lastPlayed = events.reduce<string | null>((latest, event) => !latest || Date.parse(event.playedAt) > Date.parse(latest) ? event.playedAt : latest, null)
    const genre = genres[track.id]?.trim() || track.genre?.trim()
    return {
      ...track,
      ...(genre ? { genre } : {}),
      plays,
      lastPlayed,
      listening: plays >= 10 ? 'heavy' : plays >= 3 ? 'regular' : plays >= 1 ? 'light' : 'unknown',
      hasHistory: plays > 0,
    }
  })
}

interface ListeningEdge {
  left: string
  right: string
  sessions: number
  lastSession: number
}

function edgeKey(left: string, right: string): string {
  return JSON.stringify(left < right ? [left, right] : [right, left])
}

function listeningEdges(tracks: EnrichedTrack[], history: HistoryData | null | undefined, artistsByTrack: Map<string, string>): Map<string, ListeningEdge> {
  const edges = new Map<string, ListeningEdge>()
  if (!history?.events.length) return edges
  const index = trackMatchIndex(tracks)
  const events = uniqueEvents(history.events)
    .map((event) => ({ event, time: Date.parse(event.playedAt) }))
    .filter(({ event, time }) => event.msPlayed >= MIN_PLAY_MS && Number.isFinite(event.msPlayed) && Number.isFinite(time))
    .sort((a, b) => a.time - b.time || historyKey(a.event).localeCompare(historyKey(b.event)))
  let session = 0
  let previousTime: number | null = null
  let previousArtist: string | null = null
  for (const { event, time } of events) {
    const newSession = previousTime === null || time - previousTime > SESSION_GAP_MS || Math.floor(time / 86_400_000) !== Math.floor(previousTime / 86_400_000)
    if (newSession) session += 1
    const trackId = matchedTrackId(event, index)
    const artist = trackId ? artistsByTrack.get(trackId) ?? null : null
    const nearby = previousTime !== null && time > previousTime && time - previousTime <= SESSION_GAP_MS
    if (nearby && previousArtist && artist && previousArtist !== artist) {
      const key = edgeKey(previousArtist, artist)
      let edge = edges.get(key)
      if (!edge) {
        const [left, right] = previousArtist < artist ? [previousArtist, artist] : [artist, previousArtist]
        edge = { left, right, sessions: 0, lastSession: -1 }
        edges.set(key, edge)
      }
      // Many repetitions during one continuous listening session still provide
      // only one observation. Evidence must recur in another session or date.
      if (edge.lastSession !== session) {
        edge.sessions += 1
        edge.lastSession = session
      }
    }
    previousTime = time
    previousArtist = artist
  }
  return edges
}

/** Prefer explicit genres, then repeated local listening habits, then artists. */
export function groupTracks(tracks: EnrichedTrack[], history?: HistoryData | null): PlaylistGroup[] {
  const groups = new Map<string, PlaylistGroup>()
  const artistsByTrack = new Map<string, string>()
  for (const track of tracks) {
    const genre = track.genre?.trim()
    const basis = genre ? 'genre' : 'artist'
    const name = genre || track.artist.trim() || 'Chưa rõ nghệ sĩ'
    const id = `${basis}:${normalize(name)}`
    let group = groups.get(id)
    if (!group) {
      group = {
        id,
        name,
        description: basis === 'genre' ? 'Gom theo nhãn thể loại đã có trong thư viện.' : 'Gom theo cùng nghệ sĩ vì chưa có nhãn thể loại.',
        color: groupColor(id),
        tracks: [],
        basis,
      }
      groups.set(id, group)
    }
    // Choose the same display label even if case/accent-equivalent input rows
    // arrive in a different order.
    if (name.localeCompare(group.name) < 0) group.name = name
    group.tracks.push(track)
    if (basis === 'artist') artistsByTrack.set(track.id, id)
  }

  const artists = [...groups.values()].filter((group) => group.basis === 'artist')
  const edges = listeningEdges(tracks, history, artistsByTrack)
  const membership = new Map(artists.map((group) => [group.id, group.id]))
  const communities = new Map(artists.map((group) => [group.id, new Set([group.id])]))
  const candidates = [...edges.values()].filter((edge) => edge.sessions >= MIN_SHARED_SESSIONS)
    .sort((a, b) => b.sessions - a.sessions || a.left.localeCompare(b.left) || a.right.localeCompare(b.right))

  for (const edge of candidates) {
    const leftId = membership.get(edge.left)!
    const rightId = membership.get(edge.right)!
    if (leftId === rightId) continue
    const left = communities.get(leftId)!
    const right = communities.get(rightId)!
    if (left.size + right.size > MAX_HISTORY_ARTISTS) continue
    // Complete-link clustering prevents a weak A↔B↔C bridge from claiming that
    // A and C are similar. The small cap also bounds work on dense histories.
    const supported = [...left].every((a) => [...right].every((b) => (edges.get(edgeKey(a, b))?.sessions ?? 0) >= MIN_SHARED_SESSIONS))
    if (!supported) continue
    const keepId = leftId < rightId ? leftId : rightId
    const dropId = keepId === leftId ? rightId : leftId
    const merged = new Set([...left, ...right])
    communities.set(keepId, merged)
    communities.delete(dropId)
    for (const artist of merged) membership.set(artist, keepId)
  }

  const inferred = [...communities.values()].filter((community) => community.size > 1)
    .map((community) => [...community].sort())
    .sort((a, b) => a.join('|').localeCompare(b.join('|')))
  inferred.forEach((community, index) => {
    const sourceGroups = community.map((id) => groups.get(id)!)
      .sort((a, b) => VI_SORT.compare(a.name, b.name) || a.id.localeCompare(b.id))
    const id = `history:${community.join('|')}`
    const names = sourceGroups.map((group) => group.name)
    const label = `${names.slice(0, 2).join(' / ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`
    let support = Infinity
    for (let left = 0; left < community.length; left += 1) {
      for (let right = left + 1; right < community.length; right += 1) {
        support = Math.min(support, edges.get(edgeKey(community[left], community[right]))!.sessions)
      }
    }
    for (const artist of community) groups.delete(artist)
    groups.set(id, {
      id,
      name: `Gu ${String(index + 1).padStart(2, '0')} · ${label}`,
      description: `Các cặp nghệ sĩ có ít nhất ${support} phiên nghe liền nhau trong 20 phút. Gợi ý theo thói quen trong lịch sử nghe.`,
      color: groupColor(id),
      tracks: sourceGroups.flatMap((group) => group.tracks),
      basis: 'history',
    })
  })
  return [...groups.values()].map((group) => ({
    ...group,
    tracks: [...group.tracks].sort((a, b) => VI_SORT.compare(a.artist, b.artist) || VI_SORT.compare(a.title, b.title) || a.id.localeCompare(b.id)),
  })).sort((a, b) => b.tracks.length - a.tracks.length || VI_SORT.compare(a.name, b.name) || a.id.localeCompare(b.id))
}
