import test from 'node:test'
import assert from 'node:assert/strict'
import { createScheduler } from '../lib/scheduler.mjs'

test('scheduler starts only when enabled and clamps the interval', async () => {
  let runs = 0
  const scheduler = createScheduler({ getSettings: async () => ({ scheduleEnabled: true, scheduleMinutes: 10 }), runOnce: async () => { runs += 1 } })
  const first = await scheduler.restart()
  assert.deepEqual(first, { active: true, minutes: 10 })
  assert.equal(scheduler.active(), true)
  scheduler.stop()
  assert.equal(scheduler.active(), false)
  assert.equal(runs, 0)

  const clamped = await createScheduler({ getSettings: async () => ({ scheduleEnabled: true, scheduleMinutes: 1 }), runOnce: async () => {} }).restart()
  assert.equal(clamped.minutes, 5)
  clamped.stop?.()

  const disabled = await createScheduler({ getSettings: async () => ({ scheduleEnabled: false, scheduleMinutes: 30 }), runOnce: async () => {} }).restart()
  assert.deepEqual(disabled, { active: false, minutes: 0 })
})

test('scheduler swallows runOnce errors and clamps out-of-range minutes', async () => {
  const scheduler = createScheduler({
    getSettings: async () => ({ scheduleEnabled: true, scheduleMinutes: 99999 }),
    runOnce: async () => { throw new Error('boom') },
  })
  const state = await scheduler.restart()
  assert.deepEqual(state, { active: true, minutes: 1440 })
  scheduler.stop()
})
