import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const PROVIDERS = new Set(['openai', 'anthropic', 'gemini'])
const HEADER_NAME_LIMIT = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/

function normalizeHeaders(input) {
  if (input == null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('自定义请求头格式不正确。')
  const entries = Object.entries(input).filter(([, value]) => value != null && String(value).trim() !== '')
  if (entries.length > 12) throw new Error('自定义请求头最多 12 个。')
  const headers = {}
  for (const [name, value] of entries) {
    if (!HEADER_NAME_LIMIT.test(name)) throw new Error(`请求头名称不合法：${String(name).slice(0, 40)}`)
    headers[name] = String(value).slice(0, 500)
  }
  return headers
}

function normalizeProfile(input = {}) {
  const provider = String(input.provider || '').trim()
  const name = String(input.name || '').trim().slice(0, 80)
  const group = String(input.group || '').trim().slice(0, 40)
  const baseUrl = String(input.baseUrl || '').trim()
  const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 15000, 3000), 60000)
  if (!name) throw new Error('请填写配置名称。')
  if (!PROVIDERS.has(provider)) throw new Error('服务商类型不受支持。')
  if (provider === 'openai' && !baseUrl) throw new Error('OpenAI 兼容接口需要填写 Base URL。')
  if (baseUrl) {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL 必须是 HTTP(S) 地址。')
  }
  return { name, provider, baseUrl, group, timeoutMs }
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    group: profile.group || '',
    timeoutMs: profile.timeoutMs,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    hasKey: Boolean(profile.encryptedKey),
    hasHeaders: Boolean(profile.encryptedHeaders),
  }
}

function storedProfile(input) {
  if (!input || typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.id)) return null
  try {
    const normalized = normalizeProfile(input)
    return {
      ...normalized,
      id: input.id,
      createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
      updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
      encryptedKey: typeof input.encryptedKey === 'string' ? input.encryptedKey : '',
      encryptedHeaders: typeof input.encryptedHeaders === 'string' ? input.encryptedHeaders : '',
    }
  } catch { return null }
}

export class ProfileStore {
  constructor({ filePath, encryption }) {
    this.filePath = filePath
    this.encryption = encryption
    this.loaded = false
    this.profiles = []
  }

  async load() {
    if (this.loaded) return
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8'))
      this.profiles = Array.isArray(data.profiles) ? data.profiles.map(storedProfile).filter(Boolean) : []
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error?.name === 'SyntaxError') throw new Error('配置文件已损坏，请先备份或移除 profiles.json。', { cause: error })
        throw error
      }
      this.profiles = []
    }
    this.loaded = true
  }

  async persist() {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify({ version: 1, profiles: this.profiles }, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.filePath)
  }

  async list() {
    await this.load()
    return this.profiles.map(publicProfile).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  async save(input = {}) {
    await this.load()
    const normalized = normalizeProfile(input)
    const existingIndex = this.profiles.findIndex(item => item.id === input.id)
    const existing = existingIndex >= 0 ? this.profiles[existingIndex] : null
    const hasNewKey = typeof input.apiKey === 'string' && Boolean(input.apiKey.trim())
    const hasNewHeaders = input.headers != null && typeof input.headers === 'object' && !Array.isArray(input.headers) && Object.keys(input.headers).length > 0
    const headers = hasNewHeaders ? normalizeHeaders(input.headers) : null
    if (existing && !hasNewKey && (existing.provider !== normalized.provider || existing.baseUrl !== normalized.baseUrl)) {
      throw new Error('更改服务商或 Base URL 时必须重新输入 API Key，以防密钥被发送到未确认的地址。')
    }
    const now = new Date().toISOString()
    const profile = {
      ...existing,
      ...normalized,
      id: existing?.id || randomUUID(),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }

    if (input.clearKey) profile.encryptedKey = ''
    if (input.clearHeaders) profile.encryptedHeaders = ''
    if (hasNewKey) {
      if (!this.encryption?.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用，密钥未保存。')
      profile.encryptedKey = this.encryption.encryptString(input.apiKey.trim()).toString('base64')
    }
    if (headers) {
      if (!this.encryption?.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用，请求头未保存。')
      profile.encryptedHeaders = this.encryption.encryptString(JSON.stringify(headers)).toString('base64')
    }

    if (existingIndex >= 0) this.profiles[existingIndex] = profile
    else this.profiles.push(profile)
    await this.persist()
    return publicProfile(profile)
  }

  async remove(id) {
    await this.load()
    const before = this.profiles.length
    this.profiles = this.profiles.filter(item => item.id !== id)
    if (this.profiles.length === before) return false
    await this.persist()
    return true
  }

  async resolve(id) {
    await this.load()
    const profile = this.profiles.find(item => item.id === id)
    if (!profile) throw new Error('没有找到该配置，它可能已被删除。')
    let apiKey = ''
    let headers = {}
    if (profile.encryptedKey) {
      if (!this.encryption?.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用，无法读取密钥。')
      apiKey = this.encryption.decryptString(Buffer.from(profile.encryptedKey, 'base64'))
    }
    if (profile.encryptedHeaders) {
      if (!this.encryption?.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用，无法读取请求头。')
      try { headers = normalizeHeaders(JSON.parse(this.encryption.decryptString(Buffer.from(profile.encryptedHeaders, 'base64')))) } catch { headers = {} }
    }
    return { ...publicProfile(profile), apiKey, headers }
  }
}
