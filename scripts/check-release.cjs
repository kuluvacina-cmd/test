#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdir, readFile } = require('node:fs/promises')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { chromium } = require('playwright')

const BASE = 'http://127.0.0.1:43821'
const REDIRECT = `${BASE}/callback`
const CLIENT_ID = 'a5f0a0a5c8674cd29552b64b57579f2a'
const ACCESS_TOKEN = 'release-mock-access-token'
const REFRESH_TOKEN = 'release-mock-refresh-token'
const TRACK_IDS = ['R'.repeat(22), 'S'.repeat(22)]
const PLAYLIST_ID = 'P'.repeat(22)

async function poll(predicate, message) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(50)
  }
  assert.fail(message)
}

const trackCheckboxes = page => page.getByRole('checkbox', { name: /^Chọn .+ của / })
const trackRow = (page, title) => page.getByRole('row').filter({
  has: page.getByRole('checkbox', { name: `Chọn ${title} của Release Artist`, exact: true }),
})

async function waitForCount(locator, count) {
  await poll(async () => await locator.count() === count, `Expected ${count} matching elements`)
}

async function waitForText(locator, text) {
  await poll(async () => (await locator.allInnerTexts()).some(value => value.includes(text)), `Expected visible text: ${text}`)
}

async function assertNoDemo(page) {
  assert.equal(await page.getByText('Dữ liệu mẫu', { exact: true }).count(), 0, 'Production must not offer demo data')
  assert.equal(await page.getByText(/^Lịch sử mẫu/).count(), 0, 'Production must not use synthetic listening history')
  assert.equal(await page.getByRole('button', { name: /Mở thư viện mẫu|Dùng bản mẫu/ }).count(), 0, 'Production must not expose a demo switch')
}

async function screenshot(page, name) {
  const directory = path.resolve(__dirname, '..', 'test-results')
  await mkdir(directory, { recursive: true })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.screenshot({ path: path.join(directory, name), fullPage: true })
}

async function checkRelease() {
  const health = await fetch(`${BASE}/__song_health`, { redirect: 'error', signal: AbortSignal.timeout(3000) })
  assert.equal(health.status, 200, 'The Go launcher must already be running at the release origin')
  assert.deepEqual(await health.json(), { app: 'song', version: '0.1.0' })

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const pageErrors = []
    const unexpectedRequests = []
    const routeErrors = []
    const playlistRequests = []
    const itemRequests = []
    const removedUris = []
    let authorizeRequest = null
    let tokenRequests = 0
    let libraryRequests = 0
    page.on('pageerror', error => pageErrors.push(error.message))

    const checked = handler => async route => {
      try {
        await handler(route)
      } catch (error) {
        routeErrors.push(error.message)
        await route.abort()
      }
    }
    const isSpotify = url => ['https://accounts.spotify.com', 'https://api.spotify.com'].includes(url.origin)
    await context.route(isSpotify, async route => {
      const request = route.request()
      const url = new URL(request.url())
      // Keep OAuth query strings and token bodies out of diagnostic output.
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`)
      await route.abort()
    })
    await context.route(url => url.origin === 'https://accounts.spotify.com' && url.pathname === '/authorize', checked(async route => {
      const request = route.request()
      const parameters = new URL(request.url()).searchParams
      assert.equal(request.method(), 'GET')
      assert.equal(parameters.get('client_id'), CLIENT_ID, 'The release must contain the configured public Client ID')
      assert.equal(parameters.get('redirect_uri'), REDIRECT, 'Authorization must use the native launcher callback')
      assert.equal(parameters.get('response_type'), 'code')
      assert.equal(parameters.get('code_challenge_method'), 'S256')
      assert.ok(/^[a-f0-9]{64}$/.test(parameters.get('state') || ''), 'OAuth state must be freshly generated')
      assert.ok(/^[A-Za-z0-9_-]{43}$/.test(parameters.get('code_challenge') || ''), 'PKCE must use a SHA-256 challenge')
      assert.deepEqual((parameters.get('scope') || '').split(' ').sort(), [
        'playlist-modify-private', 'user-library-modify', 'user-library-read',
      ])
      authorizeRequest = { state: parameters.get('state'), challenge: parameters.get('code_challenge') }
      const callback = new URL(REDIRECT)
      callback.searchParams.set('code', 'release-mock-code')
      callback.searchParams.set('state', authorizeRequest.state)
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><script>location.replace(${JSON.stringify(callback.href)})</script>`,
      })
    }))
    await context.route(url => url.origin === 'https://accounts.spotify.com' && url.pathname === '/api/token', checked(async route => {
      const request = route.request()
      assert.equal(request.method(), 'POST')
      const parameters = new URLSearchParams(request.postData() || '')
      assert.equal(parameters.get('grant_type'), 'authorization_code')
      assert.equal(parameters.get('client_id'), CLIENT_ID)
      assert.equal(parameters.get('redirect_uri'), REDIRECT)
      assert.equal(parameters.get('code'), 'release-mock-code')
      const verifier = parameters.get('code_verifier') || ''
      assert.ok(/^[a-f0-9]{64}$/.test(verifier), 'The token exchange must send the original PKCE verifier')
      assert.ok(authorizeRequest, 'Token exchange must follow authorization')
      assert.ok(createHash('sha256').update(verifier).digest('base64url') === authorizeRequest.challenge, 'PKCE verifier and authorization challenge must match')
      tokenRequests += 1
      await route.fulfill({ json: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600 } })
    }))
    await context.route(url => url.origin === 'https://api.spotify.com' && url.pathname.startsWith('/v1/'), checked(async route => {
      const request = route.request()
      const url = new URL(request.url())
      assert.ok(request.headers().authorization === `Bearer ${ACCESS_TOKEN}`, 'API calls must use the mocked OAuth session')
      if (request.method() === 'GET' && url.pathname === '/v1/me/tracks') {
        libraryRequests += 1
        assert.equal(url.searchParams.get('offset'), '0')
        await route.fulfill({ json: {
          items: TRACK_IDS.map((id, index) => ({
            added_at: `2026-09-0${index + 1}T12:00:00.000Z`,
            track: {
              id, uri: `spotify:track:${id}`, name: ['Release Alpha', 'Release Beta'][index],
              duration_ms: 180000, artists: [{ name: 'Release Artist' }], album: { name: 'Release album', images: [] },
            },
          })),
          next: null,
        } })
      } else if (request.method() === 'POST' && url.pathname === '/v1/me/playlists') {
        playlistRequests.push(request.postDataJSON())
        await route.fulfill({ status: 201, json: { id: PLAYLIST_ID } })
      } else if (request.method() === 'POST' && url.pathname === `/v1/playlists/${PLAYLIST_ID}/items`) {
        itemRequests.push(request.postDataJSON())
        await route.fulfill({ status: 201, json: { snapshot_id: 'release-mock-snapshot' } })
      } else if (request.method() === 'DELETE' && url.pathname === '/v1/me/library') {
        removedUris.push(...(url.searchParams.get('uris') || '').split(','))
        await route.fulfill({ status: 200, body: '' })
      } else {
        await route.fallback()
      }
    }))

    await page.goto(`${BASE}/?demo=1`)
    const login = page.getByRole('button', { name: 'Đăng nhập Spotify', exact: true })
    await login.waitFor({ state: 'visible' })
    await poll(() => login.isEnabled(), 'The production login action must become available')
    assert.equal(await trackCheckboxes(page).count(), 0, 'Production must open an empty real library even with ?demo=1')
    await assertNoDemo(page)
    await screenshot(page, 'release-empty.png')

    await login.click()
    await waitForCount(trackCheckboxes(page), 2)
    await poll(() => page.getByRole('button', { name: 'Đồng bộ Spotify', exact: true }).isEnabled(), 'OAuth callback must finish syncing')
    assert.ok(authorizeRequest, 'The main login action must directly start Spotify authorization')
    assert.equal(tokenRequests, 1)
    assert.equal(libraryRequests, 1)
    const callbackUrl = new URL(page.url())
    assert.equal(callbackUrl.origin, BASE)
    assert.equal(callbackUrl.pathname, '/callback')
    assert.equal(callbackUrl.searchParams.has('code'), false, 'OAuth authorization code must be removed from the URL')
    assert.equal(callbackUrl.searchParams.has('state'), false, 'OAuth state must be removed from the URL')
    await assertNoDemo(page)
    await waitForText(trackRow(page, 'Release Alpha'), 'Chưa ghi nhận')
    await waitForText(trackRow(page, 'Release Beta'), 'Chưa ghi nhận')
    await screenshot(page, 'release-synced.png')

    const history = [
      { endTime: '2026-09-01 12:00', trackName: 'Release Alpha', artistName: 'Release Artist', msPlayed: 180000 },
      { endTime: '2026-09-02 12:00', trackName: 'Release Alpha', artistName: 'Release Artist', msPlayed: 60000 },
    ]
    await page.getByLabel('Nhập tệp JSON lịch sử nghe Spotify', { exact: true }).setInputFiles({
      name: 'StreamingHistory0.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(history)),
    })
    await waitForText(page.getByRole('status'), 'Đã nhập 2 lượt ghi nhận.')
    await waitForText(trackRow(page, 'Release Alpha'), 'Ít nghe')
    assert.equal(await trackRow(page, 'Release Alpha').getByRole('cell', { name: '2', exact: true }).count(), 1)
    await waitForText(trackRow(page, 'Release Beta'), 'Chưa ghi nhận')

    await page.getByRole('button', { name: 'Tạo playlist Release Artist', exact: true }).click()
    const playlistDialog = page.getByRole('dialog', { name: 'Một góc riêng cho gu nhạc' })
    await playlistDialog.getByRole('textbox', { name: 'Tên playlist' }).fill('Release playlist')
    await playlistDialog.getByRole('button', { name: 'Tạo playlist riêng tư', exact: true }).click()
    await page.getByRole('dialog', { name: 'Playlist đã sẵn sàng' }).waitFor({ state: 'visible' })
    assert.equal(playlistRequests.length, 1)
    assert.equal(playlistRequests[0].name, 'Release playlist')
    assert.equal(playlistRequests[0].public, false, 'Playlist creation must remain private')
    assert.equal(playlistRequests[0].collaborative, false)
    assert.deepEqual(itemRequests, [{ uris: TRACK_IDS.map(id => `spotify:track:${id}`) }])
    await page.getByRole('button', { name: 'Xong', exact: true }).click()
    await waitForCount(trackCheckboxes(page), 2)

    await page.getByRole('button', { name: /^Ít nghe/ }).click()
    await waitForCount(trackCheckboxes(page), 1)
    await page.getByRole('checkbox', { name: 'Chọn tất cả các bài đang hiển thị', exact: true }).check()
    await page.getByRole('region', { name: 'Thao tác với các bài đã chọn' }).getByRole('button', { name: 'Bỏ thích 1 bài', exact: true }).click()
    const removalDialog = page.getByRole('dialog', { name: 'Bỏ thích 1 bài hát?' })
    assert.ok((await removalDialog.innerText()).includes('Release Alpha'))
    assert.ok(!(await removalDialog.innerText()).includes('Release Beta'), 'Unselected tracks must not enter the confirmation')
    await removalDialog.getByRole('button', { name: 'Bỏ thích 1 bài', exact: true }).click()
    await waitForText(page.getByRole('status'), 'Đã bỏ thích 1 bài trên Spotify.')
    assert.deepEqual(removedUris, [`spotify:track:${TRACK_IDS[0]}`])
    await page.getByRole('button', { name: /^Tất cả/ }).click()
    await waitForCount(trackCheckboxes(page), 1)
    assert.equal(await trackRow(page, 'Release Alpha').count(), 0)
    await trackRow(page, 'Release Beta').waitFor({ state: 'visible' })

    const downloaded = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Xuất thư viện và nhóm nhạc', exact: true }).click()
    const downloadPath = await (await downloaded).path()
    assert.ok(downloadPath)
    const exported = JSON.parse(await readFile(downloadPath, 'utf8'))
    assert.equal(exported.source, 'spotify')
    assert.deepEqual(exported.tracks.map(track => track.id), [TRACK_IDS[1]])
    assert.equal(exported.tracks[0].listening, 'unknown')
    const serialized = JSON.stringify(exported)
    assert.ok(!serialized.includes(ACCESS_TOKEN) && !serialized.includes(REFRESH_TOKEN), 'Exports must exclude session credentials')
    assert.ok(!/(?:accessToken|refreshToken|access_token|refresh_token|client_secret|code_verifier)/.test(serialized), 'Exports must not contain credential fields')
    assert.deepEqual(pageErrors, [], 'The production browser must not report uncaught errors')
    assert.deepEqual(routeErrors, [], 'All mocked Spotify requests must meet the release contract')
    assert.deepEqual(unexpectedRequests, [], 'Every Spotify request must be intercepted; none may reach the network')
    console.log('Production release checks passed: empty library, PKCE callback, sync, listening filters, private playlist, selected removal, and credential-free export.')
  } finally {
    await browser.close()
  }
}

checkRelease().catch(error => {
  console.error('Release check failed:', error.message)
  process.exitCode = 1
})
