import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createHttpServer } from '../lib/http-server.mjs'
import { ProfileStore } from '../lib/profile-store.mjs'
const root = fileURLToPath(new URL('..', import.meta.url))

const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`sealed:${value}`),
  decryptString: value => value.toString().replace(/^sealed:/, ''),
}

// fetch() rewrites the Host header and normalizes ".." out of paths, so raw
// requests are required to exercise the host check and traversal guard.
// agent:false avoids reusing a pooled keep-alive socket that belongs to an
// already-closed server from a previous test on the same port.
function rawRequest(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers, agent: false }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function withServer(options, run) {
  const server = createHttpServer({ root, ...options })
  // Port 0 lets the OS pick a free port per test, so a lingering keep-alive
  // socket from a previous test can never land on a freshly bound server.
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`
  try {
    return await run(base, server, port)
  } finally {
    server.abortAll()
    await new Promise(resolve => server.close(resolve))
  }
}

test('static assets load without a token so a bookmark works, API requires the token', async () => {
  await withServer({ profileStore: null, token: 'secret-token' }, async base => {
    const page = await fetch(`${base}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Touchstone/)

    const unauthorized = await fetch(`${base}/api/profiles`)
    assert.equal(unauthorized.status, 401)

    const viaHeader = await fetch(`${base}/api/profiles`, { headers: { 'x-local-token': 'secret-token' } })
    assert.equal(viaHeader.status, 200)

    const viaQuery = await fetch(`${base}/api/profiles?token=secret-token`)
    assert.equal(viaQuery.status, 200)
  })
})

test('requests carrying a foreign Host header are rejected to block DNS rebinding', async () => {
  await withServer({ profileStore: null, token: '' }, async (_base, _server, port) => {
    const response = await rawRequest(port, '/api/profiles', { host: 'attacker.example.com' })
    assert.equal(response.status, 403)
    assert.equal(JSON.parse(response.body).error, 'Forbidden host')
  })
})

test('only page assets are served; project files outside the allowlist are refused', async () => {
  await withServer({ profileStore: null, token: '' }, async (_base, _server, port) => {
    const host = { host: `127.0.0.1:${port}` }
    // Node's HTTP parser rejects a literal ".." request line, so traversal is
    // exercised with percent-encoded segments that decode inside the handler.
    for (const path of ['/%2e%2e/%2e%2e/package.json', '/..%2f..%2fpackage.json', '/package.json', '/node_modules/electron/package.json']) {
      const response = await rawRequest(port, path, host)
      assert.ok([403, 404].includes(response.status), `${path} returned ${response.status}`)
      assert.ok(!response.body.includes('electron-builder'), `${path} leaked project files`)
    }
    for (const path of ['/', '/index.html', '/src/main.js', '/lib/report.mjs']) {
      const response = await rawRequest(port, path, host)
      assert.equal(response.status, 200, `${path} returned ${response.status}`)
    }
  })
})

test('browser mode without a profile store cannot save profiles but still probes', async () => {
  await withServer({ profileStore: null, token: '' }, async base => {
    const capabilities = await (await fetch(`${base}/api/profiles/capabilities`)).json()
    assert.equal(capabilities.storeEnabled, false)

    const save = await fetch(`${base}/api/profiles/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', provider: 'openai', baseUrl: 'https://a.test/v1' }) })
    assert.equal(save.status, 400)

    const probe = await fetch(`${base}/api/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
    assert.equal(probe.status, 400)
    assert.equal((await probe.json()).diagnosis.code, 'validation')
  })
})

test('desktop-backed store shares encrypted profiles with the browser and hides keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-http-'))
  try {
    const profileStore = new ProfileStore({ filePath: join(directory, 'profiles.json'), encryption })
    await withServer({ profileStore, token: '' }, async base => {
      const saved = await (await fetch(`${base}/api/profiles/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Shared', provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'sk-browser-secret', timeoutMs: 10000 }),
      })).json()
      assert.equal(saved.hasKey, true)
      assert.equal('apiKey' in saved, false)

      const { profiles } = await (await fetch(`${base}/api/profiles`)).json()
      assert.equal(profiles.length, 1)
      assert.equal('encryptedKey' in profiles[0], false)

      const removed = await (await fetch(`${base}/api/profiles/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: saved.id }) })).json()
      assert.equal(removed.removed, true)
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('batch run rejects malformed job payloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-http-batch-'))
  try {
    const profileStore = new ProfileStore({ filePath: join(directory, 'profiles.json'), encryption })
    await withServer({ profileStore, token: '' }, async base => {
      const duplicate = await fetch(`${base}/api/profiles/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'job-1', ids: ['a', 'a'] }) })
      assert.equal(duplicate.status, 400)

      const empty = await fetch(`${base}/api/profiles/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'job-2', ids: [] }) })
      assert.equal(empty.status, 400)
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('malformed JSON bodies return 400 instead of crashing the server', async () => {
  await withServer({ profileStore: null, token: '' }, async base => {
    const response = await fetch(`${base}/api/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })
    assert.equal(response.status, 400)
  })
})
