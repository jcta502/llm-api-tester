import test from 'node:test'
import assert from 'node:assert/strict'
import { encryptBackup, decryptBackup, compareSemver, newerRelease } from '../lib/backup.mjs'

const profiles = [
  { id: 'x', name: 'Primary', provider: 'openai', baseUrl: 'https://a.test/v1', apiKey: 'sk-secret', headers: { 'X-Title': 't' } },
]

test('backup round-trips keys and headers through a passphrase', () => {
  const blob = encryptBackup(profiles, 'correct horse battery')
  assert.equal(blob.format, 'llm-api-tester-backup')
  assert.equal(JSON.stringify(blob).includes('sk-secret'), false)
  const restored = decryptBackup(blob, 'correct horse battery')
  assert.deepEqual(restored, profiles)
})

test('wrong passphrase or tampered blob is rejected', () => {
  const blob = encryptBackup(profiles, 'correct horse battery')
  assert.throws(() => decryptBackup(blob, 'wrong pass'), /口令不正确|损坏/)
  const tampered = { ...blob, data: Buffer.from('tampered-data').toString('base64') }
  assert.throws(() => decryptBackup(tampered, 'correct horse battery'), /口令不正确|损坏/)
  assert.throws(() => decryptBackup({ format: 'other' }, 'x'), /不是本工具导出/)
})

test('backup enforces a minimum passphrase length and non-empty profiles', () => {
  assert.throws(() => encryptBackup(profiles, '123'), /至少需要 6 个字符/)
  assert.throws(() => encryptBackup([], 'long-enough'), /没有可备份/)
})

test('release comparison treats newer tags correctly', () => {
  assert.equal(newerRelease('0.4.0', 'v0.5.0'), true)
  assert.equal(newerRelease('0.4.0', 'v0.4.0'), false)
  assert.equal(newerRelease('0.4.1', 'v0.4.0'), false)
  assert.equal(newerRelease('0.4.0', ''), false)
  assert.equal(compareSemver('1.10.0', '1.9.9') > 0, true)
})
