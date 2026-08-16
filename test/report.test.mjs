import test from 'node:test'
import assert from 'node:assert/strict'
import { batchReport, batchReportCsv, rendererProbeResult, reportResult, streamAggregate } from '../lib/report.mjs'

test('reports use a whitelist and redact common credential forms', () => {
  const report = reportResult({ ok: false, status: 401, url: 'https://user:pass@example.test/v1?key=AIzaVerySecret123', error: 'Bearer sk-secret-token-value', details: { apiKey: 'must-not-appear' }, diagnosis: { code: 'authentication', message: 'API Key 无效' } })
  const text = JSON.stringify(report)
  assert.equal(text.includes('pass'), false)
  assert.equal(text.includes('AIzaVerySecret123'), false)
  assert.equal(text.includes('must-not-appear'), false)
  assert.equal('details' in report, false)
})

test('CSV has a UTF-8 BOM, quotes fields, and neutralizes spreadsheet formulas', () => {
  const csv = batchReportCsv([{ name: '=HYPERLINK("bad")', provider: 'openai', baseUrl: 'https://example.test', state: 'success', result: { ok: true, status: 200, elapsedMs: 10, models: [] } }])
  assert.equal(csv.startsWith('\uFEFF'), true)
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/)
})

test('batch report excludes profile IDs and saved-key metadata', () => {
  const [row] = batchReport([{ id: 'private-id', hasKey: true, name: 'Safe', provider: 'openai', baseUrl: 'https://example.test', result: { ok: true, status: 200, models: ['a'] } }])
  assert.equal('id' in row, false)
  assert.equal('hasKey' in row, false)
  assert.equal(row.modelCount, 1)
})

test('batch report includes deep-check chat outcome when present', () => {
  const [deep] = batchReport([{ name: 'Deep', provider: 'openai', baseUrl: 'https://example.test', result: { ok: true, status: 200, models: ['a'], chat: { ok: false, status: 403, elapsedMs: 220, model: 'a', error: '当前密钥没有访问权限' } } }])
  assert.equal(deep.chatOk, false)
  assert.equal(deep.chatModel, 'a')
  assert.equal(deep.chatElapsedMs, 220)
  assert.equal(deep.chatError, '当前密钥没有访问权限')
  const [plain] = batchReport([{ name: 'Plain', provider: 'openai', baseUrl: 'https://example.test', result: { ok: true, status: 200, models: ['a'] } }])
  assert.equal(plain.chatOk, null)
  const csv = batchReportCsv([{ name: 'Deep', provider: 'openai', baseUrl: 'https://example.test', result: { ok: true, status: 200, models: ['a'], chat: { ok: true, elapsedMs: 120, model: 'a' } } }])
  assert.match(csv, /chatOk/)
})

test('renderer result removes raw payloads and exact arbitrary secrets', () => {
  const secret = 'custom-secret-without-a-known-prefix'
  const result = rendererProbeResult({ ok: false, status: 400, error: `upstream echoed ${secret}`, details: { secret }, attempts: [{ url: secret }], diagnosis: { code: 'bad_request', message: secret } }, secret)
  const text = JSON.stringify(result)
  assert.equal(text.includes(secret), false)
  assert.equal('details' in result, false)
  assert.equal('attempts' in result, false)
})

test('stream aggregate averages TTFT, elapsed time, and throughput across runs', () => {
  const runs = [
    { ttftMs: 100, elapsedMs: 200, content: '0123456789' },
    { ttftMs: 300, elapsedMs: 500, content: '01234567890123456789' },
    { ttftMs: 200, elapsedMs: 300, content: '01234567' },
  ]
  const agg = streamAggregate(runs)
  assert.equal(agg.runs, 3)
  assert.equal(agg.avgTtftMs, 200)
  assert.equal(agg.bestTtftMs, 100)
  assert.equal(agg.avgElapsedMs, 333)
  // 生成期总时长 = (200-100 + 500-300 + 300-200)/1000 = 0.4s，总字符 38
  assert.equal(agg.charsPerSecond, 95)
  assert.equal(agg.content, '01234567')
  assert.equal(streamAggregate([]), null)
  assert.equal(streamAggregate([{ ttftMs: null, elapsedMs: 120 }]).avgTtftMs, null)
})
