import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProfileStore } from '../lib/profile-store.mjs'

const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`sealed:${value}`),
  decryptString: value => value.toString().replace(/^sealed:/, ''),
}

test('profile store never returns the encrypted or plain API key from list/save', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-profile-'))
  const filePath = join(directory, 'profiles.json')
  try {
    const store = new ProfileStore({ filePath, encryption })
    const saved = await store.save({ name: 'Primary', provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'sk-super-secret', timeoutMs: 10000 })
    assert.equal(saved.hasKey, true)
    assert.equal('apiKey' in saved, false)
    assert.equal('encryptedKey' in saved, false)
    const listed = await store.list()
    assert.equal('apiKey' in listed[0], false)
    assert.equal('encryptedKey' in listed[0], false)
    const resolved = await store.resolve(saved.id)
    assert.equal(resolved.apiKey, 'sk-super-secret')
    const disk = await readFile(filePath, 'utf8')
    assert.equal(disk.includes('sk-super-secret'), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('editing without a key preserves the existing encrypted key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-profile-'))
  try {
    const store = new ProfileStore({ filePath: join(directory, 'profiles.json'), encryption })
    const saved = await store.save({ name: 'Before', provider: 'openai', baseUrl: 'https://example.test', apiKey: 'secret-value' })
    await store.save({ id: saved.id, name: 'After', provider: 'openai', baseUrl: 'https://example.test' })
    assert.equal((await store.resolve(saved.id)).apiKey, 'secret-value')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('corrupted profile data is reported instead of silently overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-profile-'))
  const filePath = join(directory, 'profiles.json')
  try {
    await writeFile(filePath, '{broken', 'utf8')
    const store = new ProfileStore({ filePath, encryption })
    await assert.rejects(store.list(), /配置文件已损坏/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('unknown stored fields are never exposed by the public profile contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-profile-'))
  const filePath = join(directory, 'profiles.json')
  try {
    await writeFile(filePath, JSON.stringify({ profiles: [{ id: '00000000-0000-4000-8000-000000000000', name: 'Legacy', provider: 'openai', baseUrl: 'https://example.test', timeoutMs: 15000, apiKey: 'legacy-plain-secret', surprise: 'private' }] }), 'utf8')
    const store = new ProfileStore({ filePath, encryption })
    const [profile] = await store.list()
    assert.equal('apiKey' in profile, false)
    assert.equal('surprise' in profile, false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('changing an endpoint requires the API key to be re-entered', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-profile-'))
  try {
    const store = new ProfileStore({ filePath: join(directory, 'profiles.json'), encryption })
    const saved = await store.save({ name: 'Protected', provider: 'openai', baseUrl: 'https://trusted.test/v1', apiKey: 'secret-value' })
    await assert.rejects(store.save({ id: saved.id, name: 'Protected', provider: 'openai', baseUrl: 'https://attacker.test/v1' }), /必须重新输入 API Key/)
    assert.equal((await store.resolve(saved.id)).baseUrl, 'https://trusted.test/v1')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
