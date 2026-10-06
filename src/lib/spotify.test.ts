import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../types'

class MemoryStorage implements Storage {
  private entries = new Map<string, string>()
  get length() { return this.entries.size }
  clear() { this.entries.clear() }
  getItem(key: string) { return this.entries.get(key) ?? null }
  key(index: number) { return [...this.entries.keys()][index] ?? null }
  removeItem(key: string) { this.entries.delete(key) }
  setItem(key: string, value: string) { this.entries.set(key, String(value)) }
}

const trackId = (number: number) => String(number).padStart(22, 'a')
const playlistId = 'bbbbbbbbbbbbbbbbbbbbbb'
const clientId = 'cccccccccccccccccccccccccccccccc'
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let session: MemoryStorage
let local: MemoryStorage
let location: { origin: string; href: string; search: string; assign: ReturnType<typeof vi.fn> }
let historyReplace: ReturnType<typeof vi.fn>

function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), { status, headers })
}

function storeSession(expiresAt = Date.now() + 3_600_000) {
  session.setItem('song:spotify-token', JSON.stringify({
    clientId,
    accessToken: 'access-test',
    refreshToken: 'refresh-test',
    expiresAt,
  }))
}

function libraryItem(id: string) {
  return {
    added_at: '2026-04-01T00:00:00Z',
    track: {
      id,
      uri: `spotify:track:${id}`,
      name: 'Một bài hát',
      duration_ms: 180000,
      artists: [{ id: trackId(501), name: 'Nghệ sĩ' }],
      album: { name: 'Album', images: [{ url: 'https://i.scdn.co/image/example' }] },
    },
  }
}

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv('VITE_SPOTIFY_REDIRECT_PATH', '/')
  vi.resetModules()
  session = new MemoryStorage()
  local = new MemoryStorage()
  location = { origin: 'https://song.example', href: 'https://song.example/', search: '', assign: vi.fn() }
  historyReplace = vi.fn((_state: unknown, _title: string, path: string) => {
    const url = new URL(path, location.origin)
    location.href = url.href
    location.search = url.search
  })
  fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('sessionStorage', session)
  vi.stubGlobal('localStorage', local)
  vi.stubGlobal('window', { location, history: { replaceState: historyReplace } })
  vi.stubGlobal('document', { title: 'Song' })
})

describe('Spotify library operations', () => {
  it('paginates saved tracks, ignores local/unavailable entries and reports loaded counts', async () => {
    storeSession()
    fetchMock.mockResolvedValueOnce(json({
      items: [libraryItem(trackId(1)), { track: null }, { ...libraryItem(trackId(2)), track: { ...libraryItem(trackId(2)).track, is_local: true } }],
      next: 'https://api.spotify.com/v1/me/tracks?offset=3',
    })).mockResolvedValueOnce(json({ items: [libraryItem(trackId(3)), libraryItem(trackId(1))], next: null }))
    const progress = vi.fn()
    const { fetchSpotifyLibrary } = await import('./spotify')

    const tracks = await fetchSpotifyLibrary(progress)

    expect(tracks.map((track) => track.id)).toEqual([trackId(1), trackId(3)])
    expect(tracks[0]).toMatchObject({ title: 'Một bài hát', artist: 'Nghệ sĩ', artistId: trackId(501), addedAt: '2026-04-01T00:00:00Z' })
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.spotify.com/v1/me/tracks?limit=50&offset=0',
      'https://api.spotify.com/v1/me/tracks?limit=50&offset=3',
    ])
    expect(progress.mock.calls).toEqual([[1], [2]])
  })

  it('rejects demo IDs before any Spotify mutation', async () => {
    storeSession()
    const { removeLikedTracks, createPlaylist, SpotifyMutationError } = await import('./spotify')

    await expect(removeLikedTracks([trackId(1), 'demo-track-1'])).rejects.toBeInstanceOf(SpotifyMutationError)
    await expect(createPlaylist('Demo', ['spotify:track:demo-1'])).rejects.toThrow('demo')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('deduplicates and removes liked tracks in batches of at most 40 URIs', async () => {
    storeSession()
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }))
    const { removeLikedTracks } = await import('./spotify')
    const ids = Array.from({ length: 81 }, (_, index) => trackId(index))

    await expect(removeLikedTracks([...ids, ids[0]])).resolves.toEqual(ids)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const batches = fetchMock.mock.calls.map(([url, options]) => {
      expect(options?.method).toBe('DELETE')
      expect(new URL(String(url)).pathname).toBe('/v1/me/library')
      return new URL(String(url)).searchParams.get('uris')!.split(',')
    })
    expect(batches.map((batch) => batch.length)).toEqual([40, 40, 1])
    expect(batches.flat()).toEqual(ids.map((id) => `spotify:track:${id}`))
  })

  it('reports only confirmed removals when a later batch is refused', async () => {
    storeSession()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ error: { status: 403 } }, 403))
    const { removeLikedTracks, SpotifyMutationError } = await import('./spotify')
    const ids = Array.from({ length: 45 }, (_, index) => trackId(index))

    let caught: unknown
    try { await removeLikedTracks(ids) } catch (error) { caught = error }

    expect(caught).toBeInstanceOf(SpotifyMutationError)
    expect((caught as InstanceType<typeof SpotifyMutationError>).completedIds).toEqual(ids.slice(0, 40))
    expect((caught as Error).message).toContain('403')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces Retry-After without retrying a rate-limited mutation', async () => {
    storeSession()
    fetchMock.mockResolvedValue(json({}, 429, { 'Retry-After': '45' }))
    const { removeLikedTracks } = await import('./spotify')

    await expect(removeLikedTracks([trackId(1)])).rejects.toThrow('45 giây')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('creates a private playlist and adds unique URIs in batches of 100', async () => {
    storeSession()
    fetchMock.mockResolvedValueOnce(json({ id: playlistId }, 201))
      .mockImplementation(async () => json({ snapshot_id: 'snapshot' }, 201))
    const { createPlaylist } = await import('./spotify')
    const uris = Array.from({ length: 205 }, (_, index) => `spotify:track:${trackId(index)}`)

    await expect(createPlaylist(' Nhạc thư giãn ', [...uris, uris[0]], 'Theo nhãn của bạn')).resolves.toEqual({
      id: playlistId,
      url: `https://open.spotify.com/playlist/${playlistId}`,
    })

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.spotify.com/v1/me/playlists')
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({
      name: 'Nhạc thư giãn', public: false, collaborative: false, description: 'Theo nhãn của bạn',
    })
    const batches = fetchMock.mock.calls.slice(1).map(([url, options]) => {
      expect(String(url)).toBe(`https://api.spotify.com/v1/playlists/${playlistId}/items`)
      expect(options?.method).toBe('POST')
      return JSON.parse(options!.body as string).uris as string[]
    })
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 5])
    expect(batches.flat()).toEqual(uris)
  })

  it('identifies the existing playlist and confirmed progress after partial creation', async () => {
    storeSession()
    fetchMock.mockResolvedValueOnce(json({ id: playlistId }, 201))
      .mockResolvedValueOnce(json({ snapshot_id: 'snapshot' }, 201))
      .mockResolvedValueOnce(json({}, 503))
    const { createPlaylist } = await import('./spotify')
    const uris = Array.from({ length: 150 }, (_, index) => `spotify:track:${trackId(index)}`)

    await expect(createPlaylist('Thư giãn', uris)).rejects.toThrow(`100/150 bài: https://open.spotify.com/playlist/${playlistId}`)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

function genreTrack(artistId?: string, overrides: Partial<Track> = {}): Track {
  return {
    id: trackId(1), uri: `spotify:track:${trackId(1)}`, title: 'Một bài hát', artist: 'Nghệ sĩ',
    album: 'Album', durationMs: 180000, addedAt: '2026-04-01T00:00:00Z',
    ...(artistId ? { artistId } : {}), ...overrides,
  }
}

describe('Optional public Spotify artist genre hints', () => {
  it('keeps a valid first artist ID and existing public genres from a library page', async () => {
    storeSession()
    const valid = libraryItem(trackId(1))
    const invalid = libraryItem(trackId(2))
    fetchMock.mockResolvedValueOnce(json({ items: [
      { ...valid, track: { ...valid.track, artists: [{ id: trackId(501), name: 'Nghệ sĩ', genres: [' v-pop ', 'v-pop', '', 5] }] } },
      { ...invalid, track: { ...invalid.track, artists: [{ id: 'invalid', name: 'First' }, { id: trackId(502), name: 'Second' }] } },
    ], next: null }))
    const { fetchSpotifyLibrary, fetchSpotifyGenreHints } = await import('./spotify')

    const tracks = await fetchSpotifyLibrary()
    expect(tracks[0]).toMatchObject({ artistId: trackId(501), artistGenres: ['v-pop'] })
    expect(tracks[1].artistId).toBeUndefined()
    expect(tracks[1].artist).toBe('First, Second')
    const hints = await fetchSpotifyGenreHints(tracks)
    expect(hints[0].artistGenres).toEqual(['v-pop'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('deduplicates artists, caches only public genres and preserves explicit classification', async () => {
    storeSession()
    const artistId = trackId(501)
    const tracks = [
      genreTrack(artistId, { genre: 'Jazz', language: 'Tiếng Việt', classificationSource: 'manual', classificationConfidence: 1 }),
      genreTrack(artistId, { id: trackId(2) }),
    ]
    fetchMock.mockResolvedValue(json({ id: artistId, genres: [' r&b ', 'neo soul', 'r&b', null, ''] }))
    const progress = vi.fn()
    const { fetchSpotifyGenreHints } = await import('./spotify')

    const hints = await fetchSpotifyGenreHints(tracks, { onProgress: progress })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://api.spotify.com/v1/artists/${artistId}`)
    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined()
    expect(hints[0]).toMatchObject({ genre: 'Jazz', language: 'Tiếng Việt', classificationSource: 'manual', classificationConfidence: 1, artistGenres: ['r&b', 'neo soul'] })
    expect(hints[1].artistGenres).toEqual(['r&b', 'neo soul'])
    expect(hints[0]).not.toBe(tracks[0])
    expect(tracks[0].artistGenres).toBeUndefined()
    expect(progress.mock.calls).toEqual([[0, 1], [1, 1]])
    hints[0].artistGenres!.push('caller edit')

    const cached = await fetchSpotifyGenreHints(tracks)
    expect(cached[0].artistGenres).toEqual(['r&b', 'neo soul'])
    expect(cached[1].artistGenres).not.toBe(cached[0].artistGenres)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(local.length).toBe(0)
    expect(session.length).toBe(1)
  })

  it('does not request missing or invalid artist IDs or need authentication for them', async () => {
    const tracks = [genreTrack(), genreTrack('invalid', { artistGenres: ['v-pop'], genre: 'Indie' })]
    const progress = vi.fn()
    const { fetchSpotifyGenreHints } = await import('./spotify')

    const hints = await fetchSpotifyGenreHints(tracks, { onProgress: progress })
    expect(hints).toEqual(tracks)
    expect(hints[0]).not.toBe(tracks[0])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(progress.mock.calls).toEqual([[0, 0]])
  })

  it('bounds each pass to 100 uncached unique artists and reuses successful empty metadata', async () => {
    storeSession()
    const tracks = Array.from({ length: 105 }, (_, index) => genreTrack(trackId(1000 + index), { id: trackId(index) }))
    fetchMock.mockImplementation(async url => json({ id: new URL(String(url)).pathname.split('/').at(-1), genres: [] }))
    const progress = vi.fn()
    const { fetchSpotifyGenreHints } = await import('./spotify')

    const first = await fetchSpotifyGenreHints(tracks, { onProgress: progress })
    expect(fetchMock).toHaveBeenCalledTimes(100)
    expect(first[99].artistGenres).toEqual([])
    expect(first[100].artistGenres).toBeUndefined()
    expect(progress.mock.calls[0]).toEqual([0, 100])
    expect(progress.mock.calls.at(-1)).toEqual([100, 100])
    await fetchSpotifyGenreHints(tracks)
    expect(fetchMock).toHaveBeenCalledTimes(105)
  })

  it.each([403, 429])('stops the optional pass immediately after HTTP %s', async status => {
    storeSession()
    const tracks = [genreTrack(trackId(501)), genreTrack(trackId(502)), genreTrack(trackId(503))]
    fetchMock.mockResolvedValue(json({}, status, { 'Retry-After': '30' }))
    const progress = vi.fn()
    const { fetchSpotifyGenreHints } = await import('./spotify')

    await expect(fetchSpotifyGenreHints(tracks, { onProgress: progress })).resolves.toEqual(tracks)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(progress.mock.calls).toEqual([[0, 3], [1, 3]])
    expect(session.getItem('song:spotify-token')).not.toBeNull()
  })

  it('tolerates missing genres and individual 404s without inventing labels', async () => {
    storeSession()
    const tracks = [genreTrack(trackId(501)), genreTrack(trackId(502)), genreTrack(trackId(503))]
    fetchMock.mockResolvedValueOnce(json({ id: trackId(501) }))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ id: trackId(503), genres: ['indie folk'] }))
    const { fetchSpotifyGenreHints } = await import('./spotify')

    const hints = await fetchSpotifyGenreHints(tracks)
    expect(hints[0].artistGenres).toBeUndefined()
    expect(hints[1].artistGenres).toBeUndefined()
    expect(hints[2].artistGenres).toEqual(['indie folk'])
    expect(hints.every(track => track.genre === undefined)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('returns successful partial hints after a transient failure and does not cache failed metadata', async () => {
    storeSession()
    const tracks = [genreTrack(trackId(501)), genreTrack(trackId(502)), genreTrack(trackId(503))]
    fetchMock.mockResolvedValueOnce(json({ id: trackId(501), genres: ['soul'] }))
      .mockRejectedValueOnce(new Error('internal transport details must not be exposed'))
    const { fetchSpotifyGenreHints } = await import('./spotify')

    const partial = await fetchSpotifyGenreHints(tracks)
    expect(partial[0].artistGenres).toEqual(['soul'])
    expect(partial[1].artistGenres).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fetchMock.mockImplementation(async () => json({ genres: ['pop'] }))
    const retried = await fetchSpotifyGenreHints(tracks)
    expect(retried[1].artistGenres).toEqual(['pop'])
    expect(retried[2].artistGenres).toEqual(['pop'])
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('preserves known hints and ignores artist metadata for a different ID', async () => {
    storeSession()
    const tracks = [genreTrack(trackId(501), { artistGenres: ['v-pop'], genre: 'Manual genre' })]
    fetchMock.mockResolvedValue(json({ id: trackId(502), genres: ['wrong artist genre'] }))
    const { fetchSpotifyGenreHints } = await import('./spotify')

    const hints = await fetchSpotifyGenreHints(tracks)
    expect(hints[0]).toMatchObject({ artistGenres: ['v-pop'], genre: 'Manual genre' })
    expect(hints[0].artistGenres).not.toBe(tracks[0].artistGenres)
    fetchMock.mockResolvedValue(json({ id: trackId(501), genres: ['indie'] }))
    const next = await fetchSpotifyGenreHints([genreTrack(trackId(501))])
    expect(next[0].artistGenres).toEqual(['indie'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('propagates AbortError before starting or while a request is pending', async () => {
    storeSession()
    const tracks = [genreTrack(trackId(501)), genreTrack(trackId(502))]
    const before = new AbortController()
    before.abort()
    const { fetchSpotifyGenreHints } = await import('./spotify')
    await expect(fetchSpotifyGenreHints(tracks, { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()

    const during = new AbortController()
    fetchMock.mockImplementation(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
    }))
    const pending = fetchSpotifyGenreHints(tracks, { signal: during.signal })
    during.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(during.signal)
  })

  it('checks cancellation again before saving or requesting further artist metadata', async () => {
    storeSession()
    const controller = new AbortController()
    fetchMock.mockImplementationOnce(async () => {
      controller.abort()
      return json({ id: trackId(501), genres: ['pop'] })
    })
    const { fetchSpotifyGenreHints } = await import('./spotify')

    await expect(fetchSpotifyGenreHints([genreTrack(trackId(501)), genreTrack(trackId(502))], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValue(json({ id: trackId(501), genres: ['rock'] }))
    const retried = await fetchSpotifyGenreHints([genreTrack(trackId(501))])
    expect(retried[0].artistGenres).toEqual(['rock'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('Spotify authorization lifecycle', () => {
  it('stores PKCE verifier only in session storage and uses an exact origin redirect', async () => {
    const { beginSpotifyLogin } = await import('./spotify')

    await beginSpotifyLogin(clientId)

    expect(local.getItem('song:spotify-client-id')).toBe(clientId)
    expect(local.length).toBe(1)
    const pending = JSON.parse(session.getItem('song:spotify-pkce')!)
    expect(pending.verifier).toHaveLength(64)
    const url = new URL(location.assign.mock.calls[0][0] as string)
    expect(url.origin).toBe('https://accounts.spotify.com')
    expect(url.searchParams.get('state')).toBe(pending.state)
    expect(url.searchParams.get('redirect_uri')).toBe('https://song.example/')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.has('client_secret')).toBe(false)
  })

  it('uses the configured same-origin callback path for browser authorization', async () => {
    vi.stubEnv('VITE_SPOTIFY_REDIRECT_PATH', '/callback')
    const redirectUri = `${location.origin}/callback`
    const { beginSpotifyLogin, getSpotifyRedirectUri } = await import('./spotify')

    await beginSpotifyLogin(clientId)

    expect(getSpotifyRedirectUri()).toBe(redirectUri)
    expect(location.assign).toHaveBeenCalledTimes(1)
    const authorization = new URL(location.assign.mock.calls[0][0] as string)
    expect(authorization.origin).toBe('https://accounts.spotify.com')
    expect(authorization.searchParams.get('redirect_uri')).toBe(redirectUri)
    expect(JSON.parse(session.getItem('song:spotify-pkce')!).redirectUri).toBe(redirectUri)
  })

  it('exchanges a browser callback with the configured loopback redirect URI', async () => {
    vi.stubEnv('VITE_SPOTIFY_REDIRECT_PATH', '/callback')
    const redirectUri = 'http://127.0.0.1:43821/callback'
    location.origin = 'http://127.0.0.1:43821'
    location.href = `${redirectUri}?code=private-code&state=expected`
    location.search = '?code=private-code&state=expected'
    session.setItem('song:spotify-pkce', JSON.stringify({
      clientId, verifier: 'test-verifier', state: 'expected', redirectUri, createdAt: Date.now(),
    }))
    fetchMock.mockResolvedValue(json({ access_token: 'browser-access', expires_in: 3600 }))
    const { completeSpotifyLogin } = await import('./spotify')

    await expect(completeSpotifyLogin()).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = fetchMock.mock.calls[0][1]!.body as URLSearchParams
    expect(body.get('redirect_uri')).toBe(redirectUri)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(location.href).toBe(redirectUri)
  })

  it('rejects a configured external redirect rather than sending authorization away from the app', async () => {
    vi.stubEnv('VITE_SPOTIFY_REDIRECT_PATH', '//other.example/callback')
    const { beginSpotifyLogin, getSpotifyRedirectUri } = await import('./spotify')

    expect(() => getSpotifyRedirectUri()).toThrow('chưa hợp lệ')
    await expect(beginSpotifyLogin(clientId)).rejects.toThrow('chưa hợp lệ')
    expect(location.assign).not.toHaveBeenCalled()
    expect(session.getItem('song:spotify-pkce')).toBeNull()
  })

  it('rejects a mismatched callback state and clears sensitive query parameters', async () => {
    location.href = 'https://song.example/?code=private-code&state=wrong&view=library#saved'
    location.search = '?code=private-code&state=wrong&view=library'
    session.setItem('song:spotify-pkce', JSON.stringify({
      clientId, verifier: 'test-verifier', state: 'expected', redirectUri: location.origin + '/', createdAt: Date.now(),
    }))
    const { completeSpotifyLogin } = await import('./spotify')

    await expect(completeSpotifyLogin()).rejects.toThrow('không khớp')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(session.getItem('song:spotify-pkce')).toBeNull()
    expect(location.href).toBe('https://song.example/?view=library#saved')
  })

  it('exchanges a valid callback once and stores tokens only for the browser session', async () => {
    location.href = 'https://song.example/?code=private-code&state=expected'
    location.search = '?code=private-code&state=expected'
    session.setItem('song:spotify-pkce', JSON.stringify({
      clientId, verifier: 'test-verifier', state: 'expected', redirectUri: location.origin + '/', createdAt: Date.now(),
    }))
    fetchMock.mockResolvedValue(json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }))
    const { completeSpotifyLogin, hasSpotifySession, disconnectSpotify } = await import('./spotify')

    await expect(Promise.all([completeSpotifyLogin(), completeSpotifyLogin()])).resolves.toEqual([true, true])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(local.getItem('song:spotify-token')).toBeNull()
    expect(hasSpotifySession()).toBe(true)
    expect(location.search).toBe('')
    await expect(completeSpotifyLogin()).resolves.toBe(false)
    disconnectSpotify()
    expect(hasSpotifySession()).toBe(false)
    expect(session.getItem('song:spotify-token')).toBeNull()
  })

  it('shares one token refresh across concurrent expired-session requests', async () => {
    storeSession(0)
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith('/api/token')) return json({ access_token: 'refreshed-access', expires_in: 3600 })
      return json({ items: [], next: null })
    })
    const { fetchSpotifyLibrary } = await import('./spotify')

    await expect(Promise.all([fetchSpotifyLibrary(), fetchSpotifyLibrary()])).resolves.toEqual([[], []])

    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/token'))).toHaveLength(1)
    for (const [, options] of fetchMock.mock.calls.filter(([url]) => String(url).includes('/me/tracks'))) {
      expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer refreshed-access')
    }
    expect(JSON.parse(session.getItem('song:spotify-token')!).refreshToken).toBe('refresh-test')
  })

  it('refreshes at most once after 401 and clears a session that remains unauthorized', async () => {
    storeSession()
    fetchMock.mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ access_token: 'refreshed-access', expires_in: 3600 }))
      .mockResolvedValueOnce(json({}, 401))
    const { fetchSpotifyLibrary, hasSpotifySession } = await import('./spotify')

    await expect(fetchSpotifyLibrary()).rejects.toThrow('kết nối lại')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(hasSpotifySession()).toBe(false)
  })

  it('clears a revoked refresh token and keeps the session on a temporary refresh failure', async () => {
    storeSession(0)
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400))
    const { fetchSpotifyLibrary, hasSpotifySession } = await import('./spotify')

    await expect(fetchSpotifyLibrary()).rejects.toThrow('kết nối lại')
    expect(hasSpotifySession()).toBe(false)

    storeSession(0)
    fetchMock.mockResolvedValueOnce(json({}, 429, { 'Retry-After': '20' }))
    await expect(fetchSpotifyLibrary()).rejects.toThrow('20 giây')
    expect(hasSpotifySession()).toBe(true)
  })

  it('does not restore tokens when logout occurs during token refresh', async () => {
    storeSession(0)
    let finishRefresh: ((value: Response) => void) | undefined
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finishRefresh = resolve }))
    const { fetchSpotifyLibrary, disconnectSpotify, hasSpotifySession } = await import('./spotify')
    const loading = fetchSpotifyLibrary()

    disconnectSpotify()
    finishRefresh!(json({ access_token: 'refreshed-access', refresh_token: 'replacement', expires_in: 3600 }))

    await expect(loading).rejects.toThrow('ngắt kết nối')
    expect(hasSpotifySession()).toBe(false)
    expect(session.getItem('song:spotify-token')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
