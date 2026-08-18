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

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { return {} }
}

async function mockCompatUpstream(seen) {
  const server = createServer(async (req, res) => {
    const body = req.method === 'POST' ? await readJson(req) : {}
    seen.push({ url: req.url, stream: Boolean(body.stream) })
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ data: [{ id: 'agent-model' }] }))
    }
    if (req.url === '/v1/chat/completions') {
      if (body.stream) {
        res.setHeader('content-type', 'text/event-stream')
        res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ model: 'agent-model', choices: [{ message: { content: 'OK' } }] }))
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

test('compatibility check runs models + chat + stream and derives the agent config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-compat-'))
  const seen = []
  const mock = await mockCompatUpstream(seen)
  try {
    const profileStore = new ProfileStore({ filePath: join(directory, 'profiles.json'), encryption })
    const saved = await profileStore.save({ name: 'Compat', provider: 'openai', baseUrl: `${mock.url}/v1`, apiKey: 'secret' })
    const service = createCheckService({ profileStore, historyStore: null })

    const result = await service.checkCompatibility(saved.id)
    assert.equal(result.ok, true)
    assert.equal(result.models.ok, true)
    assert.equal(result.models.count, 1)
    assert.equal(result.models.first, 'agent-model')
    assert.equal(result.chat.ok, true)
    assert.equal(result.chat.schemaOk, true)
    assert.equal(result.stream.ok, true)
    assert.ok(result.stream.chunks > 0)
    assert.ok(result.stream.ttftMs != null)
    assert.equal(result.agent.baseUrl, `${mock.url}/v1`)
    assert.equal(result.agent.model, 'agent-model')
    assert.equal(result.agent.authHeader, 'Authorization: Bearer <key>')
    assert.equal(result.agent.streamSupported, true)
    assert.equal(result.agent.schemaOk, true)
    assert.ok(seen.some(item => item.url === '/v1/models'))
    assert.ok(seen.some(item => item.stream === false))
    assert.ok(seen.some(item => item.stream === true))
    assert.ok(result.chat.raw.includes('choices'))
    assert.ok(result.stream.raw.includes('data:'))
  } finally { await mock.close(); await rm(directory, { recursive: true, force: true }) }
})

test('compatibility check flags non-compliant schema and silent streams', async () => {
  const server = createServer(async (req, res) => {
    if (req.method === 'POST') await readJson(req)
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'm' }] })) }
    if (req.url === '/v1/chat/completions') {
      // 200 with a body that is not OpenAI-compliant (no choices array).
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ ok: true, text: 'hi' }))
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const mock = { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
  const directory = await mkdtemp(join(tmpdir(), 'llm-compat-'))
  try {
    const profileStore = new ProfileStore({ filePath: join(directory, 'profiles.json'), encryption })
    const saved = await profileStore.save({ name: 'BadShape', provider: 'openai', baseUrl: `${mock.url}/v1`, apiKey: 'secret' })
    const service = createCheckService({ profileStore, historyStore: null })
    const result = await service.checkCompatibility(saved.id)
    assert.equal(result.chat.ok, true)
    assert.equal(result.chat.schemaOk, false)
    assert.match(result.chat.schemaIssue, /choices/)
    assert.equal(result.agent.schemaOk, false)
    // stream uses the same non-SSE endpoint: HTTP 200 but zero SSE chunks.
    assert.equal(result.stream.ok, false)
    assert.match(result.stream.issue, /未收到任何流式增量/)
    assert.equal(result.agent.streamSupported, false)
    // raw bodies are surfaced so the user can see what the gateway actually returned
    assert.ok(result.chat.raw.includes('"text"'))
    assert.ok(result.stream.raw.length > 0)
  } finally { await mock.close(); await rm(directory, { recursive: true, force: true }) }
})
