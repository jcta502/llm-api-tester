import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const MAX_PER_PROFILE = 20

function storedRecord(input) {
  if (!input || typeof input !== 'object') return null
  const record = {
    at: typeof input.at === 'string' ? input.at : new Date().toISOString(),
    ok: Boolean(input.ok),
    elapsedMs: Number.isFinite(input.elapsedMs) ? input.elapsedMs : 0,
    modelCount: Number.isFinite(input.modelCount) ? input.modelCount : 0,
  }
  if (typeof input.errorCode === 'string' && input.errorCode) record.errorCode = input.errorCode.slice(0, 40)
  if (typeof input.chatOk === 'boolean') record.chatOk = input.chatOk
  if (Number.isFinite(input.chatElapsedMs)) record.chatElapsedMs = input.chatElapsedMs
  return record
}

export class HistoryStore {
  constructor({ filePath, maxPerProfile = MAX_PER_PROFILE }) {
    this.filePath = filePath
    this.maxPerProfile = maxPerProfile
    this.loaded = false
    this.entries = new Map()
  }

  async load() {
    if (this.loaded) return
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8'))
      this.entries = new Map(Object.entries(data.entries || {}).map(([id, records]) => [
        id,
        (Array.isArray(records) ? records : []).map(storedRecord).filter(Boolean).slice(-this.maxPerProfile),
      ]))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error?.name === 'SyntaxError') throw new Error('检测历史文件已损坏，请删除 history.json 后重试。', { cause: error })
        throw error
      }
      this.entries = new Map()
    }
    this.loaded = true
  }

  async persist() {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporaryPath, JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.filePath)
  }

  async append(id, record) {
    await this.load()
    const stored = storedRecord(record)
    if (!id || !stored) return stored
    const records = this.entries.get(id) || []
    records.push(stored)
    this.entries.set(id, records.slice(-this.maxPerProfile))
    await this.persist()
    return stored
  }

  async get(id) {
    await this.load()
    return this.entries.get(id) || []
  }

  async all() {
    await this.load()
    return Object.fromEntries(this.entries)
  }

  async remove(id) {
    await this.load()
    if (!this.entries.has(id)) return false
    this.entries.delete(id)
    await this.persist()
    return true
  }
}
