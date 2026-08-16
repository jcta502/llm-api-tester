import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const KDF = { N: 16384, r: 8, p: 1, keylen: 32 }
const FORMAT = 'llm-api-tester-backup'

function deriveKey(passphrase, salt) {
  return scryptSync(String(passphrase || ''), salt, KDF.keylen, { N: KDF.N, r: KDF.r, p: KDF.p })
}

export function encryptBackup(profiles, passphrase) {
  if (!Array.isArray(profiles) || !profiles.length) throw new Error('没有可备份的配置。')
  if (!passphrase || String(passphrase).length < 6) throw new Error('备份口令至少需要 6 个字符。')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify({ version: 1, profiles }), 'utf8'), cipher.final()])
  return {
    format: FORMAT,
    version: 1,
    kdf: 'scrypt-N16384-r8',
    createdAt: new Date().toISOString(),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

export function decryptBackup(blob, passphrase) {
  if (!blob || blob.format !== FORMAT) throw new Error('这不是本工具导出的备份文件。')
  for (const field of ['salt', 'iv', 'tag', 'data']) {
    if (typeof blob[field] !== 'string' || !blob[field]) throw new Error('备份文件内容不完整。')
  }
  const salt = Buffer.from(blob.salt, 'base64')
  const iv = Buffer.from(blob.iv, 'base64')
  const tag = Buffer.from(blob.tag, 'base64')
  const data = Buffer.from(blob.data, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  decipher.setAuthTag(tag)
  try {
    const plain = Buffer.concat([decipher.update(data), decipher.final()])
    const payload = JSON.parse(plain.toString('utf8'))
    if (!Array.isArray(payload?.profiles)) throw new Error('备份内容无效。')
    return payload.profiles
  } catch (error) {
    if (error?.name === 'SyntaxError') throw error
    throw new Error('备份口令不正确，或文件已损坏。')
  }
}

export function compareSemver(a = '', b = '') {
  const parse = value => String(value).replace(/^v/i, '').split('.').map(part => Number.parseInt(part, 10) || 0)
  const [av, bv] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i += 1) {
    if ((av[i] || 0) !== (bv[i] || 0)) return (av[i] || 0) - (bv[i] || 0)
  }
  return 0
}

export function newerRelease(currentVersion, tag) {
  if (!tag) return false
  return compareSemver(currentVersion, tag) < 0
}
