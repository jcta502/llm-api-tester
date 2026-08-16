import test from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateChecker } from '../lib/update-check.mjs'

function mockFetch(payload, ok = true) {
  return async () => ({ ok, status: ok ? 200 : 403, json: async () => payload })
}

test('update checker detects a newer release tag', async () => {
  const checker = createUpdateChecker({ repo: 'example/example', currentVersion: '0.4.0', fetchImpl: mockFetch({ tag_name: 'v0.5.1', html_url: 'https://github.com/example/example/releases/tag/v0.5.1' }) })
  const result = await checker.check()
  assert.equal(result.hasUpdate, true)
  assert.equal(result.latest, '0.5.1')
  assert.equal(result.url.includes('v0.5.1'), true)
})

test('update checker stays silent on same version and network failure', async () => {
  const same = createUpdateChecker({ repo: 'e/e', currentVersion: '0.4.0', fetchImpl: mockFetch({ tag_name: 'v0.4.0' }) })
  assert.equal((await same.check()).hasUpdate, false)
  const failing = createUpdateChecker({ repo: 'e/e', currentVersion: '0.4.0', fetchImpl: mockFetch({}, false) })
  const failed = await failing.check()
  assert.equal(failed.hasUpdate, false)
  assert.equal(typeof failed.error, 'string')
})
