import test from 'node:test'
import assert from 'node:assert/strict'
import { batchReport, batchReportCsv, rendererProbeResult, reportResult } from '../lib/report.mjs'

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

test('renderer result removes raw payloads and exact arbitrary secrets', () => {
  const secret = 'custom-secret-without-a-known-prefix'
  const result = rendererProbeResult({ ok: false, status: 400, error: `upstream echoed ${secret}`, details: { secret }, attempts: [{ url: secret }], diagnosis: { code: 'bad_request', message: secret } }, secret)
  const text = JSON.stringify(result)
  assert.equal(text.includes(secret), false)
  assert.equal('details' in result, false)
  assert.equal('attempts' in result, false)
})
