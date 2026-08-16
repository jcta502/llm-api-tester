import { newerRelease } from './backup.mjs'

export function createUpdateChecker({ repo, currentVersion, timeoutMs = 8000, fetchImpl = fetch }) {
  let cache = null
  async function check(force = false) {
    if (cache && !force) return cache
    const fallbackUrl = `https://github.com/${repo}/releases/latest`
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'llm-api-tester' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      const tag = typeof data.tag_name === 'string' ? data.tag_name.trim() : ''
      cache = {
        current: currentVersion,
        latest: tag.replace(/^v/, ''),
        url: typeof data.html_url === 'string' && data.html_url ? data.html_url : fallbackUrl,
        hasUpdate: newerRelease(currentVersion, tag),
        checkedAt: new Date().toISOString(),
      }
    } catch {
      cache = { current: currentVersion, latest: null, url: fallbackUrl, hasUpdate: false, error: '暂时无法检查更新。', checkedAt: new Date().toISOString() }
    }
    return cache
  }
  return { check }
}
