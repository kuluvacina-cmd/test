import { test as base, expect, type Download, type Page } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const test = base.extend<{ browserHealth: void }>({
  browserHealth: [async ({ page }, use, testInfo) => {
    const errors: string[] = []
    const mutations: string[] = []
    const unhandledSpotifyRequests: string[] = []
    const mockedSpotify = testInfo.annotations.some(annotation => annotation.type === 'mocked-spotify')
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (!mockedSpotify && request.url().startsWith('https://api.spotify.com/') && ['POST', 'PUT', 'DELETE'].includes(request.method())) {
        mutations.push(`${request.method()} ${request.url()}`)
      }
    })
    // Every Spotify API request must be explicitly mocked. An accidental real
    // request fails the check and is aborted before leaving the browser.
    await page.route('https://api.spotify.com/**', async route => {
      unhandledSpotifyRequests.push(`${route.request().method()} ${route.request().url()}`)
      await route.abort()
    })
    await use()
    expect(errors, 'The browser should not report uncaught JavaScript errors').toEqual([])
    expect(mutations, 'Demo workflows must never mutate an actual Spotify account').toEqual([])
    expect(unhandledSpotifyRequests, 'Spotify API calls must be covered by an explicit test mock').toEqual([])
  }, { auto: true }],
})

const trackCheckboxes = (page: Page) => page.getByRole('checkbox', { name: /^Chọn .+ của / })
const trackRow = (page: Page, title: string, artist: string) => page.getByRole('row').filter({
  has: page.getByRole('checkbox', { name: `Chọn ${title} của ${artist}`, exact: true }),
})
const selectedActions = (page: Page) => page.getByRole('region', { name: 'Thao tác với các bài đã chọn' })

async function readDownload(download: Download) {
  const file = await download.path()
  expect(file).not.toBeNull()
  return JSON.parse(await readFile(file!, 'utf8'))
}

async function exportLibrary(page: Page) {
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Xuất thư viện và nhóm nhạc', exact: true }).click()
  return readDownload(await download)
}

async function expectNoPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?demo=1')
  await expect(trackCheckboxes(page)).toHaveCount(36)
  await expect(page.getByRole('button', { name: 'Đăng nhập Spotify', exact: true })).toBeEnabled()
})

test('opens a clearly labelled demo and fits desktop and mobile viewports', async ({ page }, testInfo) => {
  await expect(page.getByText('Dữ liệu mẫu', { exact: true })).toBeVisible()
  await expect(page.getByText('Hiển thị 1–36 / 36 bài hát', { exact: true })).toBeVisible()
  await expect(page.getByText(/^Lịch sử mẫu ·/)).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Thư viện gọn hơn.')
  await expectNoPageOverflow(page)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: path.join('test-results', `${testInfo.project.name}.png`), fullPage: true })
})

test('distinguishes light listening from missing evidence and applies search', async ({ page }) => {
  await page.getByRole('button', { name: /^Ít nghe/ }).click()
  await expect(trackCheckboxes(page)).toHaveCount(10)
  await expect(trackRow(page, 'Lạ lùng', 'Vũ.')).toBeVisible()
  await expect(trackRow(page, 'Snooze', 'SZA')).toHaveCount(0)
  await page.getByRole('button', { name: /^Chưa ghi nhận/ }).click()
  await expect(trackCheckboxes(page)).toHaveCount(4)
  await expect(trackRow(page, 'Snooze', 'SZA')).toBeVisible()
  await expect(trackRow(page, 'Lạ lùng', 'Vũ.')).toHaveCount(0)
  const search = page.getByRole('searchbox', { name: 'Tìm bài hát hoặc nghệ sĩ' })
  await search.fill('SZA')
  await expect(trackCheckboxes(page)).toHaveCount(1)
  await search.fill('không tồn tại 9387')
  await expect(page.getByRole('heading', { name: 'Chưa tìm thấy bài hát' })).toBeVisible()
  await page.getByRole('button', { name: 'Xóa bộ lọc', exact: true }).click()
  await expect(trackCheckboxes(page)).toHaveCount(36)
  await search.fill('Vũ.')
  await expect(trackCheckboxes(page)).toHaveCount(3)
})

test('selects visible rows, clears stale selection, and requires removal confirmation', async ({ page }) => {
  const search = page.getByRole('searchbox', { name: 'Tìm bài hát hoặc nghệ sĩ' })
  await search.fill('Vũ.')
  await page.getByRole('checkbox', { name: 'Chọn tất cả các bài đang hiển thị', exact: true }).check()
  await expect(selectedActions(page)).toContainText('Đã chọn 3 bài')
  await page.getByRole('button', { name: /^Ít nghe/ }).click()
  await expect(trackCheckboxes(page)).toHaveCount(1)
  await expect(selectedActions(page)).toHaveCount(0)
  await page.getByRole('checkbox', { name: 'Chọn tất cả các bài đang hiển thị', exact: true }).check()
  await selectedActions(page).getByRole('button', { name: 'Bỏ thích 1 bài', exact: true }).click()
  const singleDialog = page.getByRole('dialog', { name: 'Bỏ thích 1 bài hát?' })
  await expect(singleDialog).toContainText('Lạ lùng')
  await expect(singleDialog).not.toContainText('Bước qua nhau')
  await singleDialog.getByRole('button', { name: 'Giữ lại', exact: true }).click()
  await expect(singleDialog).toHaveCount(0)
  await expect(trackRow(page, 'Lạ lùng', 'Vũ.')).toBeVisible()
  await search.fill('')
  await expect(selectedActions(page)).toHaveCount(0)
  await page.getByRole('checkbox', { name: 'Chọn Lạ lùng của Vũ.', exact: true }).check()
  await page.getByRole('checkbox', { name: 'Chọn Đôi lời của Hà Anh Tuấn', exact: true }).check()
  await selectedActions(page).getByRole('button', { name: 'Bỏ thích 2 bài', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Bỏ thích 2 bài hát?' })
  await expect(dialog).toContainText('Spotify của bạn không bị thay đổi.')
  await dialog.getByRole('button', { name: 'Bỏ thích 2 bài', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('Đã bỏ thích 2 bài trong bản mẫu.')
  await page.getByRole('button', { name: /^Tất cả/ }).click()
  await expect(trackCheckboxes(page)).toHaveCount(34)
  await expect(trackRow(page, 'Lạ lùng', 'Vũ.')).toHaveCount(0)
  await expect(trackRow(page, 'Đôi lời', 'Hà Anh Tuấn')).toHaveCount(0)
  await expect(trackRow(page, 'Bước qua mùa cô đơn', 'Vũ.')).toBeVisible()
  await page.reload()
  await expect(trackCheckboxes(page)).toHaveCount(34)
  await expect(trackRow(page, 'Lạ lùng', 'Vũ.')).toHaveCount(0)
})

test('regroups selected tracks by genre and downloads the resulting demo playlist', async ({ page }) => {
  await page.getByRole('checkbox', { name: 'Chọn Lạ lùng của Vũ.', exact: true }).check()
  await page.getByRole('checkbox', { name: 'Chọn Đôi lời của Hà Anh Tuấn', exact: true }).check()
  await selectedActions(page).getByRole('combobox', { name: 'Chọn thể loại để gắn nhãn' }).selectOption('Jazz')
  await selectedActions(page).getByRole('button', { name: 'Áp dụng', exact: true }).click()
  await expect(trackRow(page, 'Lạ lùng', 'Vũ.')).toContainText('Jazz')
  await expect(trackRow(page, 'Đôi lời', 'Hà Anh Tuấn')).toContainText('Jazz')
  await page.getByRole('button', { name: /^Nhóm theo gu/ }).click()
  const jazz = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Jazz', exact: true }) })
  await expect(jazz).toContainText('2 bài hát')
  await jazz.getByRole('button', { name: 'Tạo playlist Jazz', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Một góc riêng cho gu nhạc' })
  await expect(dialog).toContainText('2 bài được gom theo nhãn thể loại “Jazz”')
  await dialog.getByRole('textbox', { name: 'Tên playlist' }).fill('Jazz của tui')
  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Tải playlist mẫu', exact: true }).click()
  const playlist = await readDownload(await download)
  expect(playlist.name).toBe('Jazz của tui')
  expect(playlist.source).toBe('demo')
  expect(playlist.tracks.map((track: { title: string }) => track.title).sort()).toEqual(['Lạ lùng', 'Đôi lời'].sort())
  await page.getByRole('button', { name: 'Thư viện của bạn', exact: true }).click()
  await expect(trackCheckboxes(page)).toHaveCount(36)
  await page.reload()
  await expect(trackRow(page, 'Lạ lùng', 'Vũ.')).toContainText('Jazz')
})

test('imports history, ignores short plays, deduplicates repeated files, and persists', async ({ page }) => {
  const payload = JSON.stringify([
    { endTime: '2026-09-01 12:00', trackName: 'Lạ lùng', artistName: 'Vũ.', msPlayed: 180000 },
    { endTime: '2026-09-02 12:00', trackName: 'Lạ lùng', artistName: 'Vũ.', msPlayed: 90000 },
    { endTime: '2026-09-03 12:00', trackName: 'Lạ lùng', artistName: 'Vũ.', msPlayed: 12000 },
  ])
  const input = page.getByLabel('Nhập tệp JSON lịch sử nghe Spotify', { exact: true })
  await input.setInputFiles({ name: 'StreamingHistory0.json', mimeType: 'application/json', buffer: Buffer.from(payload) })
  await expect(page.getByRole('status')).toContainText('Đã nhập 3 lượt ghi nhận.')
  await expect(page.getByText(/^Lịch sử đã nhập ·/)).toBeVisible()
  const row = trackRow(page, 'Lạ lùng', 'Vũ.')
  await expect(row).toContainText('Ít nghe')
  await expect(row.getByRole('cell', { name: '2', exact: true })).toBeVisible()
  await input.setInputFiles({ name: 'StreamingHistory0.json', mimeType: 'application/json', buffer: Buffer.from(payload) })
  await expect(page.getByRole('button', { name: 'Đăng nhập Spotify', exact: true })).toBeEnabled()
  const library = await exportLibrary(page)
  expect(library.tracks.find((track: { title: string }) => track.title === 'Lạ lùng').plays).toBe(2)
  expect(library.tracks.find((track: { title: string }) => track.title === 'Snooze').listening).toBe('unknown')
  expect(library.historyWindow).toEqual({ from: '2026-09-01T12:00:00.000Z', to: '2026-09-03T12:00:00.000Z' })
  await page.reload()
  await expect(page.getByText(/^Lịch sử đã nhập ·/)).toBeVisible()
  await expect(trackRow(page, 'Lạ lùng', 'Vũ.').getByRole('cell', { name: '2', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^Chưa ghi nhận/ }).click()
  await expect(trackCheckboxes(page)).toHaveCount(35)
  await expect(trackRow(page, 'Lạ lùng', 'Vũ.')).toHaveCount(0)
  await expect(trackRow(page, 'Snooze', 'SZA')).toBeVisible()
})

test('reports malformed history without replacing the current library', async ({ page }) => {
  await page.getByLabel('Nhập tệp JSON lịch sử nghe Spotify', { exact: true }).setInputFiles({
    name: 'bad-history.json', mimeType: 'application/json', buffer: Buffer.from('{bad json'),
  })
  await expect(page.getByRole('status')).toContainText('Không đọc được JSON.')
  await expect(trackCheckboxes(page)).toHaveCount(36)
  await expect(page.getByText(/^Lịch sử mẫu ·/)).toBeVisible()
})

test('exports library data without browser credentials', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('song:spotify-client-id', 'test-client-id-should-not-export')
    sessionStorage.setItem('private-browser-credential', 'test-private-value-should-not-export')
  })
  const library = await exportLibrary(page)
  expect(library.source).toBe('demo')
  expect(library.tracks).toHaveLength(36)
  expect(library.groups.length).toBeGreaterThan(0)
  const serialized = JSON.stringify(library)
  expect(serialized).not.toContain('test-client-id-should-not-export')
  expect(serialized).not.toContain('test-private-value-should-not-export')
  expect(serialized).not.toMatch(/access_token|refresh_token|client_secret|code_verifier/)
})

test('offers Client ID and exact redirect configuration without a secret field', async ({ page }) => {
  await page.getByRole('button', { name: 'Đăng nhập Spotify', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Kết nối Spotify của bạn' })
  await expect(dialog.getByRole('textbox', { name: 'Spotify Client ID' })).toBeVisible()
  await expect(dialog).toContainText('http://127.0.0.1:5173/')
  await expect(dialog).toContainText('Không cần Client Secret.')
  await expect(dialog.getByRole('textbox')).toHaveCount(1)
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0)
  await expect(dialog.getByRole('link', { name: /Spotify Developer Dashboard/ })).toHaveAttribute('href', 'https://developer.spotify.com/dashboard')
  await expectNoPageOverflow(page)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Đăng nhập Spotify', exact: true })).toBeFocused()
})

test('automatically groups untagged songs repeatedly heard in the same sessions', async ({ page }) => {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('song-library', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('library', 'readwrite')
      transaction.objectStore('library').put({
        version: 1, source: 'demo', genres: {}, history: null,
        tracks: ['a', 'b'].map(id => ({
          id, uri: `demo:track:${id}`, title: `Song ${id}`, artist: `Artist ${id.toUpperCase()}`,
          album: 'Test album', durationMs: 180000, addedAt: '2025-01-01T00:00:00.000Z',
        })),
      }, 'current')
      transaction.oncomplete = () => { db.close(); resolve() }
      transaction.onerror = () => { db.close(); reject(transaction.error) }
    })
  })
  await page.reload()
  await expect(trackCheckboxes(page)).toHaveCount(2)
  const history = [1, 2].flatMap(day => [
    { endTime: `2025-01-0${day} 10:00`, trackName: 'Song a', artistName: 'Artist A', msPlayed: 180000 },
    { endTime: `2025-01-0${day} 10:05`, trackName: 'Song b', artistName: 'Artist B', msPlayed: 180000 },
  ])
  await page.getByLabel('Nhập tệp JSON lịch sử nghe Spotify', { exact: true }).setInputFiles({
    name: 'StreamingHistory0.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(history)),
  })
  await expect(page.getByRole('status')).toContainText('Đã nhập 4 lượt ghi nhận.')
  await page.getByRole('button', { name: /^Nhóm theo gu/ }).click()
  const group = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Gu 01 · Artist A / Artist B', exact: true }) })
  await expect(group).toContainText('2 bài hát')
  await expect(group).toContainText('Thói quen nghe')
  const library = await exportLibrary(page)
  expect(library.groups).toEqual([{ name: 'Gu 01 · Artist A / Artist B', basis: 'history', trackIds: ['a', 'b'] }])
})

test('binds paginated Spotify sync, private playlist creation, and selected removal to the UI', {
  annotation: { type: 'mocked-spotify', description: 'All Spotify API operations use local browser routes and fake credentials.' },
}, async ({ page }) => {
  const ids = ['a'.repeat(22), 'b'.repeat(22), 'c'.repeat(22)]
  const playlistId = 'p'.repeat(22)
  const syncOffsets: string[] = []
  const createdPlaylists: Record<string, unknown>[] = []
  const playlistItems: { uris: string[] }[] = []
  const removedUris: string[] = []
  const savedTrack = (index: number) => ({
    added_at: `2026-09-0${index + 1}T12:00:00.000Z`,
    track: {
      id: ids[index], uri: `spotify:track:${ids[index]}`, name: ['Alpha', 'Beta', 'Gamma'][index],
      duration_ms: 180000, artists: [{ name: ['Artist A', 'Artist B', 'Artist C'][index] }],
      album: { name: 'Mock album', images: [] },
    },
  })
  await page.route('https://api.spotify.com/v1/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/v1/me/tracks') {
      const offset = url.searchParams.get('offset')!
      syncOffsets.push(offset)
      const result = offset === '0'
        ? { items: [savedTrack(0), savedTrack(1)], next: 'https://api.spotify.com/v1/me/tracks?limit=50&offset=2' }
        : { items: [savedTrack(2)], next: null }
      await route.fulfill({ json: result })
    } else if (request.method() === 'POST' && url.pathname === '/v1/me/playlists') {
      createdPlaylists.push(request.postDataJSON())
      await route.fulfill({ status: 201, json: { id: playlistId } })
    } else if (request.method() === 'POST' && url.pathname === `/v1/playlists/${playlistId}/items`) {
      playlistItems.push(request.postDataJSON())
      await route.fulfill({ status: 201, json: { snapshot_id: 'mock-snapshot' } })
    } else if (request.method() === 'DELETE' && url.pathname === '/v1/me/library') {
      removedUris.push(...(url.searchParams.get('uris') ?? '').split(','))
      await route.fulfill({ status: 200, body: '' })
    } else {
      await route.fallback()
    }
  })
  await page.evaluate(() => {
    sessionStorage.setItem('song:spotify-token', JSON.stringify({
      clientId: 'fake-test-client', accessToken: 'fake-test-access-token', expiresAt: Date.now() + 3600000,
    }))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Đồng bộ Spotify', exact: true }).click()
  await expect(trackCheckboxes(page)).toHaveCount(3)
  expect(syncOffsets).toEqual(['0', '2'])
  await expect(page.getByText('Dữ liệu mẫu', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Chưa có lịch sử nghe. Nhập dữ liệu để phân loại chính xác hơn.', { exact: true })).toBeVisible()
  for (const [index, title] of ['Alpha', 'Beta', 'Gamma'].entries()) {
    await expect(trackRow(page, title, `Artist ${String.fromCharCode(65 + index)}`)).toContainText('Chưa ghi nhận')
  }
  await page.getByRole('checkbox', { name: 'Chọn Alpha của Artist A', exact: true }).check()
  await page.getByRole('checkbox', { name: 'Chọn Beta của Artist B', exact: true }).check()
  await selectedActions(page).getByRole('combobox', { name: 'Chọn thể loại để gắn nhãn' }).selectOption('Jazz')
  await selectedActions(page).getByRole('button', { name: 'Áp dụng', exact: true }).click()
  await page.getByRole('button', { name: 'Tạo playlist Jazz', exact: true }).click()
  const playlistDialog = page.getByRole('dialog', { name: 'Một góc riêng cho gu nhạc' })
  await playlistDialog.getByRole('textbox', { name: 'Tên playlist' }).fill('My jazz')
  await playlistDialog.getByRole('button', { name: 'Tạo playlist riêng tư', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Playlist đã sẵn sàng' })).toBeVisible()
  expect(createdPlaylists).toHaveLength(1)
  expect(createdPlaylists[0]).toMatchObject({ name: 'My jazz', public: false, collaborative: false })
  expect(playlistItems).toEqual([{ uris: [`spotify:track:${ids[0]}`, `spotify:track:${ids[1]}`] }])
  await expect(page.getByRole('link', { name: 'Mở Spotify', exact: true })).toHaveAttribute('href', `https://open.spotify.com/playlist/${playlistId}`)
  await page.getByRole('button', { name: 'Xong', exact: true }).click()
  await expect(trackCheckboxes(page)).toHaveCount(3)
  await page.getByRole('checkbox', { name: 'Chọn Alpha của Artist A', exact: true }).check()
  await selectedActions(page).getByRole('button', { name: 'Bỏ thích 1 bài', exact: true }).click()
  const removeDialog = page.getByRole('dialog', { name: 'Bỏ thích 1 bài hát?' })
  await expect(removeDialog).toContainText('Các bài sau sẽ được gỡ khỏi Liked Songs của bạn trên Spotify.')
  await removeDialog.getByRole('button', { name: 'Bỏ thích 1 bài', exact: true }).click()
  await expect(trackCheckboxes(page)).toHaveCount(2)
  expect(removedUris).toEqual([`spotify:track:${ids[0]}`])
  await expect(trackRow(page, 'Alpha', 'Artist A')).toHaveCount(0)
  await expect(trackRow(page, 'Beta', 'Artist B')).toBeVisible()
  await expect(trackRow(page, 'Gamma', 'Artist C')).toBeVisible()
  const library = await exportLibrary(page)
  expect(library.source).toBe('spotify')
  expect(library.historyWindow).toBeNull()
  expect(library.tracks.every((track: { plays: number }) => track.plays === 0)).toBe(true)
  expect(JSON.stringify(library)).not.toContain('fake-test-access-token')
})


test('default workflow ignores saved demo and starts with an empty Spotify library', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Đăng nhập Spotify', exact: true })).toBeEnabled()
  await expect(trackCheckboxes(page)).toHaveCount(0)
  await expect(page.getByRole('article')).toHaveCount(0)
  await expect(page.getByText('Dữ liệu mẫu', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Mở thư viện mẫu', exact: true })).toHaveCount(0)
  await expect(page.getByText('Đăng nhập Spotify để mang nhạc của bạn vào đây.', { exact: true })).toBeVisible()
  const library = await exportLibrary(page)
  expect(library.source).toBe('spotify')
  expect(library.tracks).toEqual([])
  expect(library.groups).toEqual([])
  expect(library.historyWindow).toBeNull()
  await page.getByRole('button', { name: 'Cài đặt kết nối Spotify', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Kết nối Spotify của bạn' })
  await expect(dialog.getByRole('textbox', { name: 'Spotify Client ID' })).toBeVisible()
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0)
  await expect(dialog.getByRole('textbox')).toHaveCount(1)
})

test('configured public Client ID starts Spotify PKCE login directly', async ({ page }) => {
  const publicClientId = 'a'.repeat(32)
  await page.evaluate(id => localStorage.setItem('song:spotify-client-id', id), publicClientId)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Đăng nhập Spotify', exact: true })).toBeEnabled()
  await page.route('https://accounts.spotify.com/authorize**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body>Mock Spotify authorization</body></html>',
  }))
  const request = page.waitForRequest(url => url.url().startsWith('https://accounts.spotify.com/authorize?'))
  await page.getByRole('button', { name: 'Đăng nhập Spotify', exact: true }).click()
  const authorization = new URL((await request).url())
  expect(authorization.searchParams.get('client_id')).toBe(publicClientId)
  expect(authorization.searchParams.get('response_type')).toBe('code')
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
  expect(authorization.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(authorization.searchParams.get('state')).toMatch(/^[a-f0-9]{64}$/)
  expect(authorization.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5173/')
  expect(authorization.searchParams.get('scope')).toBe('user-library-read user-library-modify playlist-modify-private')
})


test('automatically arranges by language and previews a batch of sample playlists', async ({ page }) => {
  await page.getByRole('button', { name: 'Tự động sắp xếp', exact: true }).click()
  const arrangement = page.getByRole('dialog', { name: 'Tự động sắp xếp thư viện' })
  await expect(arrangement.getByRole('radio', { name: /Gợi ý nhanh, không cần key/ })).toBeChecked()
  await arrangement.getByRole('combobox', { name: 'Gom playlist theo' }).selectOption('language')
  await arrangement.getByRole('button', { name: 'Sắp xếp 36 bài', exact: true }).click()
  await expect(arrangement).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('Đã sắp xếp 36 bài theo ngôn ngữ.')
  await expect(page.getByRole('combobox', { name: 'Cách gom nhóm playlist' })).toHaveValue('language')
  const vietnamese = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Tiếng Việt', exact: true }) })
  await expect(vietnamese).toBeVisible()
  await expect(vietnamese).toContainText('Ngôn ngữ')
  await expect(vietnamese).toContainText('Có thể kiểm tra và chỉnh lại nhãn.')
  await page.getByRole('button', { name: 'Tạo nhiều playlist', exact: true }).click()
  const batch = page.getByRole('dialog', { name: 'Tạo playlist từ các nhóm' })
  await expect(batch.getByRole('checkbox', { name: 'Chọn playlist Tiếng Việt', exact: true })).toBeChecked()
  await expect(batch.getByRole('checkbox', { name: 'Chọn playlist Tiếng Anh', exact: true })).toBeChecked()
  await expect(batch).toContainText('không được chọn mặc định')
  const download = page.waitForEvent('download')
  await batch.getByRole('button', { name: /^Tải \d+ playlist mẫu$/ }).click()
  const payload = await readDownload(await download)
  expect(payload.source).toBe('demo')
  expect(payload.grouping).toBe('language')
  expect(payload.playlists.map((playlist: { name: string }) => playlist.name).sort()).toEqual(['Tiếng Anh', 'Tiếng Việt'].sort())
  expect(payload.playlists.reduce((count: number, playlist: { tracks: unknown[] }) => count + playlist.tracks.length, 0)).toBe(36)
  await expect(batch.getByRole('button', { name: 'Tải 0 playlist mẫu', exact: true })).toBeDisabled()
  await batch.getByRole('button', { name: 'Xong', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: /^Nhóm theo gu/ }).click()
  await expect(page.getByRole('combobox', { name: 'Cách gom nhóm playlist' })).toHaveValue('language')
})

test('optional AI key stays in memory and closing the dialog clears it', async ({ page }) => {
  await page.getByRole('button', { name: 'Tự động sắp xếp', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Tự động sắp xếp thư viện' })
  await dialog.getByRole('radio', { name: /Gợi ý bằng ChatGPT/ }).check()
  const key = dialog.getByLabel('OpenAI API key', { exact: true })
  await key.fill('test-key-never-save-or-export')
  await expect(dialog).toContainText('gói ChatGPT không cung cấp API key')
  await dialog.getByRole('button', { name: 'Để sau', exact: true }).click()
  await page.getByRole('button', { name: 'Tự động sắp xếp', exact: true }).click()
  await dialog.getByRole('radio', { name: /Gợi ý bằng ChatGPT/ }).check()
  await expect(dialog.getByLabel('OpenAI API key', { exact: true })).toHaveValue('')
  await dialog.getByRole('button', { name: 'Để sau', exact: true }).click()
  const library = await exportLibrary(page)
  expect(JSON.stringify(library)).not.toContain('test-key-never-save-or-export')
  expect(await page.evaluate(() => Object.values(localStorage).join(' ') + Object.values(sessionStorage).join(' '))).not.toContain('test-key-never-save-or-export')
})


test('batch preview excludes unknown labels and retry keeps completed real playlists', {
  annotation: { type: 'mocked-spotify', description: 'Sequential playlist creation and retry use fake credentials and local routes.' },
}, async ({ page }) => {
  const createdNames: string[] = []
  const addedIds: string[] = []
  let rockAttempts = 0
  await page.route('https://api.spotify.com/v1/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname === '/v1/me/playlists') {
      const body = request.postDataJSON()
      expect(body.public).toBe(false)
      expect(body.collaborative).toBe(false)
      createdNames.push(body.name)
      if (body.name === 'Rock' && rockAttempts++ === 0) {
        await route.fulfill({ status: 503, json: { error: { message: 'mock failure' } } })
      } else await route.fulfill({ status: 201, json: { id: (body.name === 'Jazz' ? 'j' : 'r').repeat(22) } })
    } else if (request.method() === 'POST' && /^\/v1\/playlists\/[jr]{22}\/items$/.test(url.pathname)) {
      addedIds.push(url.pathname.split('/')[3])
      await route.fulfill({ status: 201, json: { snapshot_id: 'fake-snapshot' } })
    } else await route.fallback()
  })
  await page.evaluate(async () => {
    sessionStorage.setItem('song:spotify-token', JSON.stringify({ clientId: 'fake-test-client', accessToken: 'fake-test-token', expiresAt: Date.now() + 3600000 }))
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('song-library', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('library', 'readwrite')
      transaction.objectStore('library').put({
        version: 1, source: 'spotify', genres: {}, history: null, groupMode: 'genre',
        tracks: ['Jazz', 'Rock', 'Chưa rõ thể loại'].map((genre, index) => ({
          id: String.fromCharCode(97 + index).repeat(22), uri: `spotify:track:${String.fromCharCode(97 + index).repeat(22)}`,
          title: `Track ${index}`, artist: `Artist ${index}`, album: 'Mock album', durationMs: 180000, addedAt: '2026-09-01T00:00:00.000Z', genre,
        })),
      }, 'current')
      transaction.oncomplete = () => { db.close(); resolve() }
      transaction.onerror = () => { db.close(); reject(transaction.error) }
    })
  })
  await page.goto('/')
  await expect(trackCheckboxes(page)).toHaveCount(3)
  await page.getByRole('button', { name: /^Nhóm theo gu/ }).click()
  await page.getByRole('button', { name: 'Tạo nhiều playlist', exact: true }).click()
  const batch = page.getByRole('dialog', { name: 'Tạo playlist từ các nhóm' })
  await expect(batch.getByRole('checkbox', { name: 'Chọn playlist Chưa rõ thể loại', exact: true })).not.toBeChecked()
  await batch.getByRole('button', { name: 'Tạo 2 playlist riêng tư', exact: true }).click()
  await expect(batch.getByRole('alert')).toContainText('Các playlist đã tạo được giữ lại.')
  await expect(batch.getByRole('checkbox', { name: 'Chọn playlist Jazz', exact: true })).toBeDisabled()
  await expect(batch.getByRole('button', { name: 'Tạo 1 playlist riêng tư', exact: true })).toBeEnabled()
  expect(createdNames).toEqual(['Jazz', 'Rock'])
  await batch.getByRole('button', { name: 'Tạo 1 playlist riêng tư', exact: true }).click()
  await expect(batch.getByRole('button', { name: 'Tạo 0 playlist riêng tư', exact: true })).toBeDisabled()
  expect(createdNames).toEqual(['Jazz', 'Rock', 'Rock'])
  expect(addedIds).toEqual(['j'.repeat(22), 'r'.repeat(22)])
  await expect(batch.getByRole('link', { name: 'Mở playlist Jazz trên Spotify', exact: true })).toHaveAttribute('href', `https://open.spotify.com/playlist/${'j'.repeat(22)}`)
  await batch.getByRole('button', { name: 'Xong', exact: true }).click()
  await page.getByRole('button', { name: 'Thư viện của bạn', exact: true }).click()
  await expect(trackCheckboxes(page)).toHaveCount(3)
})

test('cancelling AI classification leaves original labels intact', async ({ page }) => {
  await page.route('https://api.openai.com/v1/responses', () => {})
  await page.getByRole('button', { name: 'Tự động sắp xếp', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Tự động sắp xếp thư viện' })
  await dialog.getByRole('radio', { name: /Gợi ý bằng ChatGPT/ }).check()
  await dialog.getByLabel('OpenAI API key', { exact: true }).fill('fake-key-for-cancellation-test')
  const request = page.waitForRequest('https://api.openai.com/v1/responses')
  await dialog.getByRole('button', { name: 'Sắp xếp 36 bài', exact: true }).click()
  await request
  await dialog.getByRole('button', { name: 'Hủy sắp xếp', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('Đã hủy sắp xếp.')
  const library = await exportLibrary(page)
  expect(library.tracks).toHaveLength(36)
  expect(library.tracks.find((track: { title: string }) => track.title === 'Lạ lùng').genre).toBe('Indie Việt')
  expect(library.tracks.every((track: { language?: string }) => !track.language)).toBe(true)
  expect(JSON.stringify(library)).not.toContain('fake-key-for-cancellation-test')
})
