import test from 'node:test'
import assert from 'node:assert/strict'
import { runBatch } from '../lib/batch-runner.mjs'

test('batch runner preserves input order and enforces concurrency', async () => {
  let active = 0
  let maximum = 0
  const { results, completed } = await runBatch([1, 2, 3, 4, 5], async value => {
    active += 1; maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 8))
    active -= 1
    return value * 2
  }, { concurrency: 2 })
  assert.deepEqual(results, [2, 4, 6, 8, 10])
  assert.equal(completed, 5)
  assert.equal(maximum, 2)
})

test('batch runner stops scheduling new work after cancellation', async () => {
  const controller = new AbortController()
  let started = 0
  const output = await runBatch([1, 2, 3, 4], async value => {
    started += 1
    if (value === 1) controller.abort()
    return value
  }, { concurrency: 1, signal: controller.signal })
  assert.equal(output.cancelled, true)
  assert.equal(output.completed, 1)
  assert.equal(started, 1)
})
