import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export function normalizeProxyUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('代理地址必须是 http:// 或 https:// 开头。')
  return url.toString()
}

export class SettingsStore {
  constructor({ filePath }) {
    this.filePath = filePath
    this.loaded = false
    this.settings = { proxyUrl: '', scheduleEnabled: false, scheduleMinutes: 30 }
  }

  async load() {
    if (this.loaded) return this.settings
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8'))
      this.settings = {
        proxyUrl: typeof data.proxyUrl === 'string' ? data.proxyUrl : '',
        scheduleEnabled: Boolean(data.scheduleEnabled),
        scheduleMinutes: Number.isFinite(Number(data.scheduleMinutes)) && Number(data.scheduleMinutes) >= 5 ? Number(data.scheduleMinutes) : 30,
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error?.name === 'SyntaxError') throw new Error('设置文件已损坏，请删除 settings.json 后重试。', { cause: error })
        throw error
      }
      this.settings = { proxyUrl: '', scheduleEnabled: false, scheduleMinutes: 30 }
    }
    this.loaded = true
    return this.settings
  }

  async persist() {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporaryPath, JSON.stringify({ version: 1, ...this.settings }, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.filePath)
  }

  async get() { return { ...(await this.load()) } }

  async set({ proxyUrl, scheduleEnabled, scheduleMinutes } = {}) {
    await this.load()
    if (proxyUrl !== undefined) this.settings.proxyUrl = normalizeProxyUrl(proxyUrl)
    if (scheduleEnabled !== undefined) this.settings.scheduleEnabled = Boolean(scheduleEnabled)
    if (scheduleMinutes !== undefined) {
      const minutes = Number(scheduleMinutes)
      if (!Number.isFinite(minutes) || minutes < 5 || minutes > 1440) throw new Error('定时检测间隔必须在 5 到 1440 分钟之间。')
      this.settings.scheduleMinutes = Math.round(minutes)
    }
    await this.persist()
    return { ...(this.settings) }
  }
}
