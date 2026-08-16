export function createScheduler({ getSettings, runOnce, minMinutes = 5, maxMinutes = 1440 }) {
  let timer = null

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  async function tick() {
    try { await runOnce() } catch { /* 定时任务异常不能影响应用 */ }
  }

  async function restart() {
    stop()
    const settings = await getSettings().catch(() => null)
    if (!settings?.scheduleEnabled) return { active: false, minutes: 0 }
    const minutes = Math.min(Math.max(Number(settings.scheduleMinutes) || 0, minMinutes), maxMinutes)
    if (!minutes) return { active: false, minutes: 0 }
    timer = setInterval(tick, minutes * 60 * 1000)
    timer.unref?.()
    return { active: true, minutes }
  }

  return { restart, stop, active: () => Boolean(timer) }
}
