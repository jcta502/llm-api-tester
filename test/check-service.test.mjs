import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProfileStore } from '../lib/profile-store.mjs'
import { HistoryStore } from '../lib/history-store.mjs'
import { createCheckService } from '../lib/check-service.mjs'

const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`sealed:${value}`),
  decryptString: value => value.toString().replace(/^sealed:/, ''),
}

async function mockUpstream(seen) {
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'chat-model' }, { id: 'other-model' }] }))
    if (req.url === '/v1/chat/completions') return res.end(JSON.stringify({ model: 'chat-model', choices: [{ message: { content: 'OK' } }] }))
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

test('deep check lists models then performs a real chat call and records history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-check-'))
  const seen = []
  const mock = await mockUpstream(seen)
  try {
    const profileStore = new ProfileStore({ filePath: join(directory, 'profiles.json'), encryption })
    const historyStore = new HistoryStore({ filePath: join(directory, 'history.json') })
    const saved = await profileStore.save({ name: 'Deep', provider: 'openai', baseUrl: `${mock.url}/v1`, apiKey: 'secret' })
    const service = createCheckService({ profileStore, historyStore })

    const result = await service.checkProfile(saved.id, { deep: true })
    assert.equal(result.ok, true)
    assert.equal(result.deep, true)
    assert.equal(result.chat.ok, true)
    assert.equal(result.chat.model, 'chat-model')
    assert.equal(result.deepModel, 'chat-model')
    assert.ok(seen.some(item => item.url === '/v1/models'))
    assert.ok(seen.some(item => item.url === '/v1/chat/completions'))

    const [record] = await historyStore.get(saved.id)
    assert.equal(record.ok, true)
    assert.equal(record.modelCount, 2)
    assert.equal(record.chatOk, true)
  } finally { await mock.close(); await rm(directory, { recursive: true, force: true }) }
})

test('deep check honors an explicit model and reports missing keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-check-'))
  const seen = []
  const mock = await mockUpstream(seen)
  try {
    const profileStore = new ProfileStore({ filePath: join(directory, 'profiles.json'), encryption })
    const service = createCheckService({ profileStore, historyStore: null })
    const saved = await profileStore.save({ name: 'Explicit', provider: 'openai', baseUrl: `${mock.url}/v1`, apiKey: 'secret' })

    const result = await service.checkProfile(saved.id, { deep: true, model: 'other-model' })
    assert.equal(result.deepModel, 'other-model')
    assert.equal(seen.filter(item => item.url === '/v1/chat/completions').length, 1)

    const noKey = await profileStore.save({ name: 'NoKey', provider: 'openai', baseUrl: `${mock.url}/v1` })
    const missing = await service.checkProfile(noKey.id, { deep: true })
    assert.equal(missing.ok, false)
    assert.equal(missing.diagnosis.code, 'missing_key')
    assert.equal(missing.chat, undefined)
  } finally { await mock.close(); await rm(directory, { recursive: true, force: true }) }
})
