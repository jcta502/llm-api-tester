import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HistoryStore } from '../lib/history-store.mjs'

test('history store keeps at most 20 records per profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-history-'))
  try {
    const store = new HistoryStore({ filePath: join(directory, 'history.json') })
    for (let i = 0; i < 25; i += 1) await store.append('p1', { ok: i % 2 === 0, elapsedMs: i, modelCount: 1 })
    const records = await store.get('p1')
    assert.equal(records.length, 20)
    assert.equal(records[0].elapsedMs, 5)
    assert.equal(records.at(-1).elapsedMs, 24)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('history store separates and removes profiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-history-'))
  try {
    const store = new HistoryStore({ filePath: join(directory, 'history.json') })
    await store.append('p1', { ok: true, elapsedMs: 10, modelCount: 3 })
    await store.append('p2', { ok: false, elapsedMs: 20, errorCode: 'dns' })
    const all = await store.all()
    assert.equal(all.p1.length, 1)
    assert.equal(all.p2[0].errorCode, 'dns')
    assert.equal(await store.remove('p1'), true)
    assert.deepEqual(await store.get('p1'), [])
    assert.equal((await store.all()).p2.length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
