import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { probePayload } from '../lib/probe.mjs'

async function mockServer(handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

test('normalizes full models URL and discovers OpenAI models', async () => {
  const seen = []
  const mock = await mockServer((req, res) => {
    seen.push(req.url)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-test' }] }))
    res.statusCode = 404
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  })
  try {
    const result = await probePayload({ provider: 'openai', baseUrl: `${mock.url}/v1/models`, apiKey: 'secret', action: 'models' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.models, ['gpt-test'])
    assert.equal(result.resolvedEndpoint, `${mock.url}/v1/models`)
    assert.equal(seen.includes('/v1/models'), true)
  } finally { await mock.close() }
})

test('falls back from chat completions to Responses API', async () => {
  const mock = await mockServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/responses') return res.end(JSON.stringify({ model: 'responses-test', output_text: 'OK', usage: { total_tokens: 3 } }))
    res.statusCode = 404
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  })
  try {
    const result = await probePayload({ provider: 'openai', baseUrl: `${mock.url}/v1`, apiKey: 'secret', action: 'chat', model: 'responses-test' })
    assert.equal(result.ok, true)
    assert.equal(result.apiStyle, 'responses')
    assert.equal(result.content, 'OK')
  } finally { await mock.close() }
})

test('measures streaming time to first token', async () => {
  const mock = await mockServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    setTimeout(() => res.write('data: {"choices":[{"delta":{"content":"O"}}]}\n\n'), 20)
    setTimeout(() => { res.write('data: {"choices":[{"delta":{"content":"K"}}]}\n\n'); res.end('data: [DONE]\n\n') }, 40)
  })
  try {
    const result = await probePayload({ provider: 'openai', baseUrl: `${mock.url}/v1`, apiKey: 'secret', action: 'stream', model: 'stream-test' })
    assert.equal(result.ok, true)
    assert.equal(result.content, 'OK')
    assert.equal(result.chunks, 2)
    assert.equal(typeof result.ttftMs, 'number')
  } finally { await mock.close() }
})

test('returns a structured authentication diagnosis', async () => {
  const mock = await mockServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad key' } }))
  })
  try {
    const result = await probePayload({ provider: 'openai', baseUrl: mock.url, apiKey: 'bad', action: 'models' })
    assert.equal(result.ok, false)
    assert.equal(result.diagnosis.code, 'authentication')
    assert.equal(result.diagnosis.upstream, 'bad key')
  } finally { await mock.close() }
})
