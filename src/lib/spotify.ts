import type { Track } from '../types'

const API_ORIGIN = 'https://api.spotify.com/v1'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const CLIENT_ID_KEY = 'song:spotify-client-id'
const TOKEN_KEY = 'song:spotify-token'
const PKCE_KEY = 'song:spotify-pkce'
const TRACK_ID = /^[A-Za-z0-9]{22}$/
const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/

interface Session {
  clientId: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

interface PendingLogin {
  clientId: string
  verifier: string
  state: string
  redirectUri: string
  createdAt: number
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
}

interface SavedTracksPage {
  items: {
    added_at?: string
    track: {
      id?: string
      uri?: string
      name?: string
      is_local?: boolean
      duration_ms?: number
      artists?: { id?: string; name?: string; genres?: unknown }[]
      album?: { name?: string; images?: { url?: string }[] }
    } | null
  }[]
  next?: string | null
}

let refreshInFlight: Promise<Session> | null = null
let callbackInFlight: Promise<boolean> | null = null
let sessionGeneration = 0
const artistGenreCache = new Map<string, string[]>()

class SpotifyHttpError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export class SpotifyMutationError extends Error {
  readonly completedIds: string[]

  constructor(message: string, completedIds: string[]) {
    super(message)
    this.name = 'SpotifyMutationError'
    this.completedIds = [...completedIds]
  }
}

function readSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const session = value as Partial<Session>
    if (
      typeof session.clientId !== 'string' || !session.clientId ||
      typeof session.accessToken !== 'string' || !session.accessToken ||
      typeof session.expiresAt !== 'number' || !Number.isFinite(session.expiresAt) ||
      (session.refreshToken !== undefined && typeof session.refreshToken !== 'string')
    ) return null
    return session as Session
  } catch {
    return null
  }
}

function saveSession(session: Session) {
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify(session))
  } catch {
    throw new Error('Trình duyệt không cho lưu phiên Spotify. Hãy cho phép bộ nhớ phiên rồi kết nối lại.')
  }
}

export function hasSpotifySession(): boolean {
  const session = readSession()
  return !!session && (!!session.refreshToken || session.expiresAt > Date.now())
}

export function disconnectSpotify(): void {
  sessionGeneration += 1
  refreshInFlight = null
  sessionStorage.removeItem(TOKEN_KEY)
  sessionStorage.removeItem(PKCE_KEY)
}

function randomHex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes))
  return [...values].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export function getSpotifyRedirectUri(): string {
  const path = import.meta.env.VITE_SPOTIFY_REDIRECT_PATH || '/'
  if (path !== '/' && path !== '/callback') {
    throw new Error('Đường dẫn phản hồi Spotify của ứng dụng chưa hợp lệ. Hãy mở ứng dụng từ bản cài đặt đầy đủ.')
  }
  return `${window.location.origin}${path}`
}

export async function beginSpotifyLogin(clientId: string): Promise<void> {
  const cleanId = clientId.trim()
  if (!/^[A-Za-z0-9]{16,128}$/.test(cleanId)) {
    throw new Error('Client ID chưa hợp lệ. Sao chép Client ID từ Spotify Developer Dashboard.')
  }
  if (!crypto.subtle) {
    throw new Error('Đăng nhập cần trang HTTPS hoặc địa chỉ máy bạn http://127.0.0.1.')
  }

  const verifier = randomHex(32)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const state = randomHex(32)
  const redirectUri = getSpotifyRedirectUri()
  const pending: PendingLogin = { clientId: cleanId, verifier, state, redirectUri, createdAt: Date.now() }

  localStorage.setItem(CLIENT_ID_KEY, cleanId)
  sessionStorage.setItem(PKCE_KEY, JSON.stringify(pending))
  const parameters = new URLSearchParams({
    client_id: cleanId,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: 'user-library-read user-library-modify playlist-modify-private',
  })
  const authorizeUrl = `https://accounts.spotify.com/authorize?${parameters}`
  window.location.assign(authorizeUrl)
}

function clearCallbackUrl() {
  const url = new URL(window.location.href)
  for (const key of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(key)
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`)
}

async function errorForResponse(response: Response, isAuth = false): Promise<Error> {
  const error = (message: string) => new SpotifyHttpError(message, response.status)
  if (response.status === 429) {
    const retryHeader = response.headers.get('Retry-After')
    let waitSeconds = retryHeader ? Number(retryHeader) : NaN
    if (retryHeader && !Number.isFinite(waitSeconds)) {
      waitSeconds = Math.ceil((Date.parse(retryHeader) - Date.now()) / 1000)
    }
    const wait = Number.isFinite(waitSeconds) && waitSeconds > 0
      ? `Chờ khoảng ${Math.ceil(waitSeconds)} giây rồi thử lại.`
      : 'Chờ một lúc rồi thử lại.'
    return error(`Spotify đang giới hạn số yêu cầu (429). ${wait}`)
  }
  if (response.status === 403) {
    return error('Spotify từ chối quyền truy cập (403). Kiểm tra quyền đã cấp, người dùng được cho phép trong app và yêu cầu Premium của chế độ phát triển.')
  }
  if (response.status === 401 || (isAuth && response.status === 400)) {
    return error(isAuth
      ? 'Spotify không chấp nhận phiên đăng nhập. Kiểm tra Client ID và Redirect URI trong Dashboard rồi kết nối lại.'
      : 'Phiên Spotify không còn hợp lệ. Hãy kết nối lại.')
  }
  return error(`Spotify trả về lỗi ${response.status}. ${response.status >= 500 ? 'Hãy thử lại sau.' : 'Kiểm tra yêu cầu và quyền của app.'}`)
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new DOMException('Đã hủy việc đọc thông tin Spotify.', 'AbortError')
}

async function fetchResponse(url: string, options: RequestInit): Promise<Response> {
  throwIfAborted(options.signal)
  try {
    return await fetch(url, options)
  } catch (cause) {
    throwIfAborted(options.signal)
    if (cause instanceof Error && cause.name === 'AbortError') throw cause
    throw new Error('Không kết nối được với Spotify. Kiểm tra mạng và thử lại.')
  }
}

async function exchangeToken(parameters: URLSearchParams): Promise<TokenResponse> {
  const response = await fetchResponse(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: parameters,
  })
  if (!response.ok) throw await errorForResponse(response, true)
  const token = await response.json() as Partial<TokenResponse>
  if (
    typeof token.access_token !== 'string' || !token.access_token ||
    typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0 ||
    (token.refresh_token !== undefined && typeof token.refresh_token !== 'string')
  ) throw new Error('Spotify trả về phiên đăng nhập không hợp lệ. Hãy kết nối lại.')
  return token as TokenResponse
}

async function finishLogin(): Promise<boolean> {
  const parameters = new URLSearchParams(window.location.search)
  const code = parameters.get('code')
  const error = parameters.get('error')
  if (!code && !error) return false

  const pendingRaw = sessionStorage.getItem(PKCE_KEY)
  sessionStorage.removeItem(PKCE_KEY)
  clearCallbackUrl()
  if (error) throw new Error('Bạn chưa cấp quyền Spotify. Có thể kết nối lại khi sẵn sàng.')

  let pending: PendingLogin | null = null
  try {
    pending = pendingRaw ? JSON.parse(pendingRaw) as PendingLogin : null
  } catch {
    // A damaged or missing verifier cannot authorize a session.
  }
  if (
    !pending || typeof pending.verifier !== 'string' || !pending.verifier ||
    typeof pending.clientId !== 'string' || !pending.clientId ||
    typeof pending.state !== 'string' || !pending.state ||
    parameters.get('state') !== pending.state ||
    pending.redirectUri !== getSpotifyRedirectUri() ||
    typeof pending.createdAt !== 'number' || !Number.isFinite(pending.createdAt) ||
    Date.now() - pending.createdAt > 10 * 60 * 1000 || pending.createdAt > Date.now()
  ) throw new Error('Phiên đăng nhập đã hết hạn hoặc không khớp. Hãy kết nối Spotify lại từ trang này.')

  const generation = sessionGeneration
  const token = await exchangeToken(new URLSearchParams({
    client_id: pending.clientId,
    grant_type: 'authorization_code',
    code: code!,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
  }))
  if (generation !== sessionGeneration) throw new Error('Đã ngắt kết nối Spotify. Hãy kết nối lại nếu muốn tiếp tục.')
  saveSession({
    clientId: pending.clientId,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
  })
  return true
}

export function completeSpotifyLogin(): Promise<boolean> {
  if (callbackInFlight) return callbackInFlight
  const task = finishLogin()
  callbackInFlight = task
  void task.finally(() => {
    if (callbackInFlight === task) callbackInFlight = null
  }).catch(() => undefined)
  return task
}

async function refreshSession(previous: Session): Promise<Session> {
  const current = readSession()
  if (current && current.accessToken !== previous.accessToken && current.expiresAt > Date.now() + 30_000) return current
  if (refreshInFlight) return refreshInFlight
  if (!current?.refreshToken) {
    disconnectSpotify()
    throw new Error('Phiên Spotify đã hết hạn. Hãy kết nối lại.')
  }

  const generation = sessionGeneration
  const task = (async () => {
    const token = await exchangeToken(new URLSearchParams({
      client_id: current.clientId,
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken!,
    }))
    if (generation !== sessionGeneration) throw new Error('Đã ngắt kết nối Spotify. Hãy kết nối lại nếu muốn tiếp tục.')
    const updated: Session = {
      clientId: current.clientId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token || current.refreshToken,
      expiresAt: Date.now() + token.expires_in * 1000,
    }
    saveSession(updated)
    return updated
  })()
  refreshInFlight = task
  try {
    return await task
  } catch (error) {
    if (generation === sessionGeneration && error instanceof SpotifyHttpError && [400, 401].includes(error.status)) {
      disconnectSpotify()
    }
    throw error
  } finally {
    if (refreshInFlight === task) refreshInFlight = null
  }
}

async function requestSpotify<T>(path: string, options: RequestInit = {}): Promise<T> {
  throwIfAborted(options.signal)
  let session = readSession()
  if (!session) throw new Error('Hãy kết nối Spotify trước khi thao tác với thư viện thật.')
  if (session.expiresAt <= Date.now() + 30_000) session = await refreshSession(session)
  throwIfAborted(options.signal)

  const send = (current: Session) => {
    const headers = new Headers(options.headers)
    headers.set('Authorization', `Bearer ${current.accessToken}`)
    if (options.body) headers.set('Content-Type', 'application/json')
    return fetchResponse(`${API_ORIGIN}${path}`, { ...options, headers })
  }
  let response = await send(session)
  throwIfAborted(options.signal)
  if (response.status === 401) {
    session = await refreshSession(session)
    throwIfAborted(options.signal)
    response = await send(session)
    throwIfAborted(options.signal)
    if (response.status === 401) disconnectSpotify()
  }
  if (!response.ok) throw await errorForResponse(response)
  const text = await response.text()
  throwIfAborted(options.signal)
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error('Spotify trả về dữ liệu không đọc được. Hãy thử lại.')
  }
}

export async function fetchSpotifyLibrary(onProgress?: (count: number) => void): Promise<Track[]> {
  const tracks = new Map<string, Track>()
  let offset = 0
  for (let pageCount = 0; pageCount < 1000; pageCount += 1) {
    const page = await requestSpotify<SavedTracksPage>(`/me/tracks?limit=50&offset=${offset}`)
    if (!page || !Array.isArray(page.items)) throw new Error('Spotify trả về thư viện không hợp lệ.')
    for (const item of page.items) {
      const track = item?.track
      if (!track?.id || !TRACK_ID.test(track.id) || track.is_local || track.uri !== `spotify:track:${track.id}`) continue
      const artwork = track.album?.images?.find((image) => image.url?.startsWith('https://'))?.url
      const firstArtist = track.artists?.[0]
      const artistId = firstArtist?.id && TRACK_ID.test(firstArtist.id) ? firstArtist.id : undefined
      const artistGenres = publicGenres(firstArtist?.genres)
      if (artistId && artistGenres) artistGenreCache.set(artistId, artistGenres)
      tracks.set(track.id, {
        id: track.id,
        uri: track.uri,
        title: track.name || 'Chưa rõ tên bài',
        artist: track.artists?.map((artist) => artist.name).filter(Boolean).join(', ') || 'Chưa rõ nghệ sĩ',
        ...(artistId ? { artistId } : {}),
        ...(artistGenres ? { artistGenres } : {}),
        album: track.album?.name || '',
        durationMs: typeof track.duration_ms === 'number' && Number.isFinite(track.duration_ms) ? Math.max(0, track.duration_ms) : 0,
        addedAt: item.added_at && !Number.isNaN(Date.parse(item.added_at)) ? item.added_at : '',
        artwork,
      })
    }
    onProgress?.(tracks.size)
    if (!page.next) return [...tracks.values()]
    if (!page.items.length) throw new Error('Spotify trả về trang trống khi thư viện chưa tải xong. Hãy thử lại.')
    offset += page.items.length
  }
  throw new Error('Thư viện vượt quá giới hạn 50.000 bài của lần tải này. Dữ liệu chưa được lưu; hãy thử lại với thư viện nhỏ hơn.')
}

function publicGenres(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return [...new Set(value.filter((genre): genre is string => typeof genre === 'string').map(genre => genre.trim()).filter(Boolean))]
}

/**
 * Read optional public artist metadata only when explicitly requested.
 * Spotify may omit its deprecated genres field or deny this endpoint. Those
 * outcomes leave unknown tracks available for another classification method.
 */
export async function fetchSpotifyGenreHints(tracks: Track[], options: {
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
} = {}): Promise<Track[]> {
  throwIfAborted(options.signal)
  const artistIds = [...new Set(tracks.map(track => track.artistId).filter((id): id is string => typeof id === 'string' && TRACK_ID.test(id)))]
  const pending = artistIds.filter(id => !artistGenreCache.has(id)).slice(0, 100)
  let done = 0
  options.onProgress?.(done, pending.length)
  for (const artistId of pending) {
    throwIfAborted(options.signal)
    let stop = false
    try {
      const artist = await requestSpotify<{ id?: unknown; genres?: unknown }>(`/artists/${artistId}`, { signal: options.signal })
      throwIfAborted(options.signal)
      const genres = publicGenres(artist?.genres)
      if (genres && (artist?.id === undefined || artist.id === artistId)) {
        artistGenreCache.set(artistId, genres)
      }
    } catch (cause) {
      throwIfAborted(options.signal)
      if (cause instanceof Error && cause.name === 'AbortError') throw cause
      // A missing individual artist does not deny access to every artist.
      // Other failures stop this optional pass rather than issuing more calls.
      stop = !(cause instanceof SpotifyHttpError && cause.status === 404)
    }
    done += 1
    options.onProgress?.(done, pending.length)
    if (stop) break
  }
  throwIfAborted(options.signal)
  return tracks.map(track => {
    const known = publicGenres(track.artistGenres)
    const genres = known?.length ? known : track.artistId ? artistGenreCache.get(track.artistId) : undefined
    return { ...track, ...(genres ? { artistGenres: [...genres] } : {}) }
  })
}

export async function removeLikedTracks(ids: string[]): Promise<string[]> {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.some((id) => !TRACK_ID.test(id))) {
    throw new SpotifyMutationError('Danh sách có bài demo hoặc ID không hợp lệ. Chỉ có thể bỏ thích bài từ thư viện Spotify thật.', [])
  }
  const completedIds: string[] = []
  try {
    // The unified library endpoint accepts at most 40 URIs per request.
    for (let offset = 0; offset < uniqueIds.length; offset += 40) {
      const batch = uniqueIds.slice(offset, offset + 40)
      const parameters = new URLSearchParams({ uris: batch.map((id) => `spotify:track:${id}`).join(',') })
      await requestSpotify<void>(`/me/library?${parameters}`, { method: 'DELETE' })
      completedIds.push(...batch)
    }
    return completedIds
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Không bỏ thích được các bài đã chọn.'
    throw new SpotifyMutationError(message, completedIds)
  }
}

export async function createPlaylist(name: string, uris: string[], description?: string): Promise<{ id: string; url: string }> {
  const cleanName = name.trim()
  const uniqueUris = [...new Set(uris)]
  if (!cleanName || cleanName.length > 100) throw new Error('Tên playlist cần từ 1 đến 100 ký tự.')
  if (!uniqueUris.length || uniqueUris.some((uri) => !TRACK_URI.test(uri))) {
    throw new Error('Playlist cần các bài từ thư viện Spotify thật; không thể gửi bài demo lên Spotify.')
  }
  if (description && description.length > 300) throw new Error('Mô tả playlist tối đa 300 ký tự.')

  const playlist = await requestSpotify<{ id: string }>('/me/playlists', {
    method: 'POST',
    body: JSON.stringify({ name: cleanName, public: false, collaborative: false, ...(description ? { description } : {}) }),
  })
  if (!playlist?.id || !TRACK_ID.test(playlist.id)) {
    throw new Error('Spotify đã nhận yêu cầu tạo playlist nhưng không trả về ID hợp lệ. Kiểm tra playlist trong Spotify trước khi tạo lại.')
  }
  const url = `https://open.spotify.com/playlist/${playlist.id}`
  let added = 0
  try {
    for (let offset = 0; offset < uniqueUris.length; offset += 100) {
      const batch = uniqueUris.slice(offset, offset + 100)
      await requestSpotify<unknown>(`/playlists/${playlist.id}/items`, {
        method: 'POST',
        body: JSON.stringify({ uris: batch }),
      })
      added += batch.length
    }
    return { id: playlist.id, url }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Không thêm được bài vào playlist.'
    throw new Error(`${message} Playlist “${cleanName}” đã được tạo và xác nhận thêm ${added}/${uniqueUris.length} bài: ${url}. Kiểm tra playlist này trước khi tạo lại.`)
  }
}
