import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SettingsStore } from '../lib/settings-store.mjs'

test('settings store validates and persists proxy urls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-settings-'))
  try {
    const store = new SettingsStore({ filePath: join(directory, 'settings.json') })
    assert.deepEqual(await store.get(), { proxyUrl: '', scheduleEnabled: false, scheduleMinutes: 30 })
    const saved = await store.set({ proxyUrl: 'http://127.0.0.1:7890' })
    assert.equal(saved.proxyUrl, 'http://127.0.0.1:7890/')
    await assert.rejects(store.set({ proxyUrl: 'ftp://example.com' }), /http/)
    await assert.rejects(store.set({ proxyUrl: 'not a url' }))
    assert.equal((await store.get()).proxyUrl, 'http://127.0.0.1:7890/')
    const reopened = new SettingsStore({ filePath: join(directory, 'settings.json') })
    assert.equal((await reopened.get()).proxyUrl, 'http://127.0.0.1:7890/')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('settings store schedules round-trip and range validation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'llm-settings-'))
  try {
    const store = new SettingsStore({ filePath: join(directory, 'settings.json') })
    const saved = await store.set({ scheduleEnabled: true, scheduleMinutes: 60 })
    assert.deepEqual(saved, { proxyUrl: '', scheduleEnabled: true, scheduleMinutes: 60 })
    await assert.rejects(store.set({ scheduleMinutes: 2 }), /5 到 1440/)
    await assert.rejects(store.set({ scheduleMinutes: 10000 }), /5 到 1440/)
    const reopened = new SettingsStore({ filePath: join(directory, 'settings.json') })
    const loaded = await reopened.get()
    assert.equal(loaded.scheduleEnabled, true)
    assert.equal(loaded.scheduleMinutes, 60)
    // 关闭后 proxyUrl 等其他字段保持不变（部分更新）
    await reopened.set({ scheduleEnabled: false })
    assert.equal((await reopened.get()).scheduleMinutes, 60)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
