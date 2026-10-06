import { describe, expect, it } from 'vitest'
import type { HistoryData, HistoryEvent, Track } from '../types'
import { demoLibrary } from './demo'
import { enrichTracks, groupTracks, mergeHistory, parseHistory } from './library'

function track(id = 'a', overrides: Partial<Track> = {}): Track {
  return { id, uri: `spotify:track:${id}`, title: 'Bước qua mùa cô đơn', artist: 'Vũ.', album: 'Album', durationMs: 200_000, addedAt: '2024-01-01T00:00:00.000Z', ...overrides }
}

function event(index = 0, overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return { trackId: 'a', title: 'Bước qua mùa cô đơn', artist: 'Vũ.', playedAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString(), msPlayed: 120_000, ...overrides }
}

function history(events: HistoryEvent[]): HistoryData {
  return { source: 'import', events, from: null, to: null }
}

function tasteTrack(id: string, overrides: Partial<Track> = {}): Track {
  return track(id, { title: `Song ${id}`, artist: `Artist ${id.toUpperCase()}`, ...overrides })
}

function listeningSessions(sessions: string[][], gapMinutes = 5): HistoryData {
  return history(sessions.flatMap((ids, session) => ids.map((id, index) => event(0, {
    trackId: id,
    title: `Song ${id}`,
    artist: `Artist ${id.toUpperCase()}`,
    playedAt: new Date(Date.UTC(2025, 0, session + 1, 10, index * gapMinutes)).toISOString(),
  }))))
}

describe('enrichTracks', () => {
  it('counts the 30-second boundary and applies listening thresholds', () => {
    for (const [plays, listening] of [[0, 'unknown'], [1, 'light'], [2, 'light'], [3, 'regular'], [9, 'regular'], [10, 'heavy']] as const) {
      const [result] = enrichTracks([track()], history(Array.from({ length: plays }, (_, index) => event(index, { msPlayed: 30_000 }))))
      expect(result.plays).toBe(plays)
      expect(result.listening).toBe(listening)
      expect(result.hasHistory).toBe(plays > 0)
    }
  })

  it('does not call absence or a short preview an unplayed song', () => {
    const [result] = enrichTracks([track()], history([event(8, { msPlayed: 29_999 })]))
    expect(result).toMatchObject({ plays: 0, listening: 'unknown', lastPlayed: null, hasHistory: false })
    expect(enrichTracks([track()], null)[0].listening).toBe('unknown')
  })

  it('uses the latest qualifying play rather than a recent short skip', () => {
    const [result] = enrichTracks([track()], history([event(0), event(3), event(8, { msPlayed: 1000 })]))
    expect(result.plays).toBe(2)
    expect(result.lastPlayed).toBe(event(3).playedAt)
  })

  it('matches an explicit Spotify ID even when title metadata differs', () => {
    const [result] = enrichTracks([track()], history([event(0, { title: 'A renamed recording', artist: 'Another label' })]))
    expect(result.plays).toBe(1)
  })

  it('does not fall back to names when a different recording has an ID', () => {
    const [result] = enrichTracks([track()], history([event(0, { trackId: 'anotherRecording' })]))
    expect(result.plays).toBe(0)
  })

  it('matches classic exports by normalized exact title and artist without fuzzy merging', () => {
    const [result] = enrichTracks([track()], history([
      event(0, { trackId: undefined, title: '  BUOC   QUA MUA CO DON ', artist: 'vu.' }),
      event(1, { trackId: undefined, title: 'Bước qua mùa cô đơn (Live)' }),
      event(2, { trackId: undefined, artist: 'Vũ' }),
    ]))
    expect(result.plays).toBe(1)
  })

  it('leaves classic evidence unattributed when two saved recording IDs share a normalized name', () => {
    const recordings = [track('a'), track('b', { title: ' BUOC QUA MUA CO DON ', artist: 'vu.' })]
    const results = enrichTracks(recordings, history([event(0, { trackId: undefined })]))
    expect(results.map((item) => item.listening)).toEqual(['unknown', 'unknown'])
    expect(results.every((item) => item.plays === 0 && item.lastPlayed === null)).toBe(true)
  })

  it('uses an extended ID to identify one of two otherwise ambiguous recordings', () => {
    const results = enrichTracks([track('a'), track('b')], history([event(0), event(1, { trackId: undefined })]))
    expect(results.map((item) => item.plays)).toEqual([1, 0])
    expect(results[0].lastPlayed).toBe(event(0).playedAt)
    expect(results[1].listening).toBe('unknown')
  })

  it('allows duplicate library rows of one recording ID to share classic evidence', () => {
    const results = enrichTracks([track('a'), track('a')], history([event(0, { trackId: undefined })]))
    expect(results.map((item) => item.plays)).toEqual([1, 1])
  })

  it('deduplicates repeated imports while retaining genuinely separate plays', () => {
    const [result] = enrichTracks([track()], history([event(0), event(0), event(1)]))
    expect(result.plays).toBe(2)
  })

  it('uses an explicit genre override ahead of a track genre', () => {
    expect(enrichTracks([track('a', { genre: 'Pop' })], null, { a: 'Indie Việt' })[0].genre).toBe('Indie Việt')
  })
})

describe('parseHistory and mergeHistory', () => {
  const extended = {
    ts: '2025-01-12T08:12:33Z',
    master_metadata_track_name: 'Bước qua mùa cô đơn',
    master_metadata_album_artist_name: 'Vũ.',
    spotify_track_uri: 'spotify:track:a',
    ms_played: 120_000,
  }

  it('reads extended music and filters mixed podcast, invalid, and duplicate entries', () => {
    const result = parseHistory(JSON.stringify([
      extended,
      { ...extended },
      { ts: extended.ts, master_metadata_track_name: null, master_metadata_album_artist_name: null, episode_name: 'A podcast', spotify_episode_uri: 'spotify:episode:podcast', ms_played: 200_000 },
      { ...extended, episode_name: 'Actually a podcast' },
      { ...extended, ts: '2025-02-30T08:12:33Z' },
      { ...extended, ms_played: -1 },
      { ...extended, ms_played: '120000' },
      null,
    ]))
    expect(result.events).toEqual([event(0, { playedAt: '2025-01-12T08:12:33.000Z' })])
    expect(result.source).toBe('import')
    expect(result.from).toBe(result.to)
  })

  it('reads classic timestamps as UTC and preserves short listens without counting them', () => {
    const result = parseHistory(JSON.stringify([{ endTime: '2025-01-01 12:45', artistName: 'Vũ.', trackName: 'Bước qua mùa cô đơn', msPlayed: 29_000 }]))
    expect(result.events[0]).toEqual({ title: 'Bước qua mùa cô đơn', artist: 'Vũ.', playedAt: '2025-01-01T12:45:00.000Z', msPlayed: 29_000 })
    expect(enrichTracks([track()], result)[0].plays).toBe(0)
  })

  it('accepts extended metadata with no URI and normalizes timezone offsets', () => {
    const result = parseHistory(JSON.stringify([{ ...extended, spotify_track_uri: null, ts: '2025-01-12T15:12:33+07:00' }]))
    expect(result.events[0].trackId).toBeUndefined()
    expect(result.events[0].playedAt).toBe('2025-01-12T08:12:33.000Z')
  })

  it('reports malformed and unsupported files with useful Vietnamese errors', () => {
    expect(() => parseHistory('{oops')).toThrow(/Không đọc được JSON/)
    expect(() => parseHistory('{}')).toThrow(/mảng JSON/)
    expect(() => parseHistory('[]')).toThrow(/Không tìm thấy lượt nghe nhạc hợp lệ/)
    expect(() => parseHistory(JSON.stringify([{ ...extended, ts: 'not a timestamp' }]))).toThrow(/Không tìm thấy lượt nghe nhạc hợp lệ/)
  })

  it('merges imports in chronological order and recomputes date coverage without double counting', () => {
    const merged = mergeHistory(history([event(2), event(0)]), history([event(1), event(0)]))
    expect(merged.events).toEqual([event(0), event(1), event(2)])
    expect(merged.from).toBe(event(0).playedAt)
    expect(merged.to).toBe(event(2).playedAt)
    expect(mergeHistory(null, history([]))).toMatchObject({ events: [], from: null, to: null })
  })

  it('deduplicates an overlapping classic and extended play while preserving the Spotify ID', () => {
    const classic = parseHistory(JSON.stringify([{ endTime: '2025-01-12 08:12', trackName: ' BUOC QUA MUA CO DON ', artistName: 'vu.', msPlayed: 120_000 }]))
    const extendedHistory = parseHistory(JSON.stringify([{ ...extended, ts: '2025-01-12T08:12:00Z' }]))
    for (const merged of [mergeHistory(classic, extendedHistory), mergeHistory(extendedHistory, classic)]) {
      expect(merged.events).toEqual(extendedHistory.events)
      expect(enrichTracks([track()], merged)[0].plays).toBe(1)
    }
  })

  it('preserves distinct explicit recording IDs even with identical names, times, and durations', () => {
    const merged = mergeHistory(history([event(0), event(0, { trackId: undefined })]), history([event(0, { trackId: 'b' })]))
    expect(merged.events).toEqual([event(0), event(0, { trackId: 'b' })])
    expect(enrichTracks([track('a'), track('b')], merged).map((item) => item.plays)).toEqual([1, 1])
  })

  it('retains a classic play when its timestamp or duration differs from an identified play', () => {
    const merged = mergeHistory(history([event(0)]), history([
      event(1, { trackId: undefined }),
      event(0, { trackId: undefined, msPlayed: 110_000 }),
    ]))
    expect(merged.events).toHaveLength(3)
    expect(enrichTracks([track()], merged)[0].plays).toBe(3)
  })
})

describe('groupTracks', () => {
  it('groups explicit genres and honestly falls back to the artist', () => {
    const tracks = enrichTracks([
      track('a', { genre: 'Indie Việt' }),
      track('b', { title: 'Có em', artist: 'Madihu', genre: 'Indie Việt' }),
      track('c', { genre: undefined }),
      track('d', { genre: undefined, title: 'Lạ lùng' }),
      track('e', { artist: 'SZA', title: 'Good Days', genre: 'R&B' }),
    ], null)
    const groups = groupTracks(tracks)
    expect(groups.map((group) => [group.name, group.tracks.length, group.basis])).toEqual([
      ['Indie Việt', 2, 'genre'],
      ['Vũ.', 2, 'artist'],
      ['R&B', 1, 'genre'],
    ])
    expect(groups[1].description).toContain('chưa có nhãn thể loại')
    expect(groupTracks([...tracks].reverse())).toEqual(groups)
  })

  it('does not confuse a genre label with an artist of the same name', () => {
    const groups = groupTracks(enrichTracks([track('a', { genre: 'Pop' }), track('b', { artist: 'Pop' })], null))
    expect(groups).toHaveLength(2)
    expect(new Set(groups.map((group) => group.id)).size).toBe(2)
  })

  it('groups different artists after nearby listening recurs in two sessions', () => {
    const habits = listeningSessions([['a', 'b'], ['a', 'b']], 20)
    const groups = groupTracks(enrichTracks([tasteTrack('a'), tasteTrack('b')], habits), habits)
    expect(groups).toHaveLength(1)
    expect(groups[0].basis).toBe('history')
    expect(groups[0].name).toBe('Gu 01 · Artist A / Artist B')
    expect(groups[0].description).toContain('2 phiên nghe liền nhau')
    expect(groups[0].tracks.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('does not infer taste from one coincidence or many repetitions in only one session', () => {
    for (const habits of [listeningSessions([['a', 'b']]), listeningSessions([['a', 'b', 'a', 'b', 'a', 'b']])]) {
      const groups = groupTracks(enrichTracks([tasteTrack('a'), tasteTrack('b')], habits), habits)
      expect(groups.map((group) => group.basis)).toEqual(['artist', 'artist'])
    }
  })

  it('does not link plays separated by more than twenty minutes', () => {
    const habits = listeningSessions([['a', 'b'], ['a', 'b']], 21)
    const groups = groupTracks(enrichTracks([tasteTrack('a'), tasteTrack('b')], habits), habits)
    expect(groups).toHaveLength(2)
    expect(groups.every((group) => group.basis === 'artist')).toBe(true)
  })

  it('recognizes repeated nearby listening across midnight and separate same-day sessions', () => {
    const tracks = [tasteTrack('a'), tasteTrack('b')]
    const midnight = listeningSessions([['a', 'b'], ['a', 'b']])
    midnight.events = midnight.events.map((item, index) => ({
      ...item,
      playedAt: new Date(Date.UTC(2025, 0, 1 + Math.floor(index / 2), 23, 58 + (index % 2) * 5)).toISOString(),
    }))
    const sameDay = listeningSessions([['a', 'b'], ['a', 'b']])
    sameDay.events = sameDay.events.map((item, index) => ({
      ...item,
      playedAt: new Date(Date.UTC(2025, 0, 1, 10 + Math.floor(index / 2) * 2, (index % 2) * 5)).toISOString(),
    }))
    for (const habits of [midnight, sameDay]) {
      expect(groupTracks(enrichTracks(tracks, habits), habits)[0].basis).toBe('history')
    }
  })

  it('keeps explicit genre labels ahead of listening-habit grouping', () => {
    const habits = listeningSessions([['a', 'b'], ['a', 'b']])
    const enriched = enrichTracks([tasteTrack('a'), tasteTrack('b')], habits, { a: 'Pop' })
    const groups = groupTracks(enriched, habits)
    expect(groups.map((group) => [group.name, group.basis])).toEqual([['Artist B', 'artist'], ['Pop', 'genre']])
  })

  it('keeps two repeated pairs apart when a different session supplies only a bridge', () => {
    const habits = listeningSessions([['a', 'b'], ['a', 'b'], ['c', 'd'], ['c', 'd'], ['b', 'c'], ['b', 'c']])
    const groups = groupTracks(enrichTracks(['a', 'b', 'c', 'd'].map((id) => tasteTrack(id)), habits), habits)
    expect(groups.map((group) => group.tracks.map((item) => item.id))).toEqual([['a', 'b'], ['c', 'd']])
    expect(groups.every((group) => group.basis === 'history')).toBe(true)
  })

  it('does not turn a repeated broad-session chain into one giant group', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const habits = listeningSessions([ids, ids])
    const groups = groupTracks(enrichTracks(ids.map((id) => tasteTrack(id)), habits), habits)
    expect(groups.map((group) => group.tracks.map((item) => item.id))).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']])
  })

  it('allows a small dense community when every artist pair has repeated evidence', () => {
    const habits = listeningSessions([['a', 'b', 'c', 'a'], ['a', 'b', 'c', 'a']])
    const groups = groupTracks(enrichTracks(['a', 'b', 'c'].map((id) => tasteTrack(id)), habits), habits)
    expect(groups).toHaveLength(1)
    expect(groups[0].tracks.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(groups[0].basis).toBe('history')
  })

  it('preserves same-artist groups when no history is available', () => {
    const groups = groupTracks(enrichTracks([tasteTrack('a'), tasteTrack('b', { artist: 'Artist A' }), tasteTrack('c')], null))
    expect(groups.map((group) => [group.name, group.tracks.length, group.basis])).toEqual([['Artist A', 2, 'artist'], ['Artist C', 1, 'artist']])
  })

  it('does not use ambiguous classic names for co-listening edges', () => {
    const tracks = [tasteTrack('a'), tasteTrack('a2', { title: 'Song a', artist: 'Artist A' }), tasteTrack('b')]
    const habits = listeningSessions([['a', 'b'], ['a', 'b']])
    const classic = history(habits.events.map((item) => ({ ...item, trackId: undefined })))
    const groups = groupTracks(enrichTracks(tracks, classic), classic)
    expect(groups.map((group) => [group.name, group.basis])).toEqual([['Artist A', 'artist'], ['Artist B', 'artist']])
    expect(groupTracks(enrichTracks(tracks, habits), habits)[0].basis).toBe('history')
  })

  it('requires qualifying plays and avoids linking through unknown music', () => {
    const tracks = [tasteTrack('a'), tasteTrack('b')]
    const short = listeningSessions([['a', 'b'], ['a', 'b']])
    short.events = short.events.map((item) => ({ ...item, msPlayed: 10_000 }))
    const unmatched = listeningSessions([['a', 'unknown', 'b'], ['a', 'unknown', 'b']])
    for (const habits of [short, unmatched]) {
      expect(groupTracks(enrichTracks(tracks, habits), habits).every((group) => group.basis === 'artist')).toBe(true)
    }
  })

  it('is deterministic when library and history input orders change', () => {
    const tracks = ['a', 'b', 'c', 'd'].map((id) => tasteTrack(id))
    const habits = listeningSessions([['a', 'b'], ['a', 'b'], ['c', 'd'], ['c', 'd']])
    const groups = groupTracks(enrichTracks(tracks, habits), habits)
    const reversed = history([...habits.events].reverse())
    expect(groupTracks(enrichTracks([...tracks].reverse(), reversed), reversed)).toEqual(groups)
  })
})

describe('demoLibrary', () => {
  it('is explicitly demo data with synthetic IDs and diverse observed listening levels', () => {
    const demo = demoLibrary()
    expect(demo.source).toBe('demo')
    expect(demo.history?.source).toBe('demo')
    expect(demo.tracks).toHaveLength(36)
    expect(demo.tracks.every((item) => item.id.startsWith('demo-') && !item.artwork)).toBe(true)
    expect(new Set(enrichTracks(demo.tracks, demo.history).map((item) => item.listening))).toEqual(new Set(['heavy', 'regular', 'light', 'unknown']))
    expect(groupTracks(enrichTracks(demo.tracks, demo.history)).map((group) => group.basis)).toEqual(Array(5).fill('genre'))
  })

  it('supports changing a demo track genre through the same explicit tag map used for Spotify tracks', () => {
    const demo = demoLibrary()
    const id = demo.tracks[0].id
    const genres = { ...demo.genres, [id]: 'R&B' }
    const enriched = enrichTracks(demo.tracks, demo.history, genres)
    expect(enriched[0].genre).toBe('R&B')
    expect(groupTracks(enriched).find((group) => group.name === 'R&B')?.tracks.some((item) => item.id === id)).toBe(true)
    expect(demo.tracks[0].genre).toBe('Indie Việt')
  })
})
