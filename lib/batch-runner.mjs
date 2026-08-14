export async function runBatch(items, worker, options = {}) {
  const concurrency = Math.min(Math.max(Number(options.concurrency) || 3, 1), 6)
  const signal = options.signal
  const results = new Array(items.length)
  let cursor = 0

  async function runNext() {
    while (true) {
      if (signal?.aborted) return
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        results[index] = await worker(items[index], { index, signal })
      } catch (error) {
        results[index] = {
          ok: false,
          status: 0,
          elapsedMs: 0,
          error: signal?.aborted ? '检测已取消。' : (error?.message || '程序处理失败。'),
          diagnosis: {
            code: signal?.aborted ? 'cancelled' : 'internal',
            message: signal?.aborted ? '检测已取消' : '程序处理失败',
          },
        }
      }
      try { options.onResult?.(items[index], results[index], index) } catch { /* Progress reporting must not abort the batch. */ }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext))
  return { results, cancelled: Boolean(signal?.aborted), completed: results.filter(Boolean).length }
}
