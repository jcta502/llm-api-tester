import { probePayload } from './probe.mjs'
import { rendererProbeResult } from './report.mjs'

const missingKeyResult = () => ({
  ok: false, status: 400, elapsedMs: 0,
  error: '该配置没有保存密钥。',
  diagnosis: { code: 'missing_key', message: '缺少已保存的密钥', hint: '编辑配置并重新输入 API Key。' },
})

function compactChat(result) {
  return {
    ok: Boolean(result.ok),
    status: Number(result.status) || 0,
    elapsedMs: Number.isFinite(result.elapsedMs) ? result.elapsedMs : 0,
    model: result.model || undefined,
    error: result.ok ? undefined : (result.diagnosis?.message || result.error),
    errorCode: result.ok ? undefined : result.diagnosis?.code,
  }
}

export function createCheckService({ profileStore, historyStore }) {
  async function recordHistory(id, listResult, chatResult, deep) {
    if (!historyStore) return
    try {
      await historyStore.append(id, {
        ok: Boolean(listResult.ok),
        elapsedMs: listResult.elapsedMs || 0,
        modelCount: Array.isArray(listResult.models) ? listResult.models.length : 0,
        errorCode: listResult.ok ? undefined : (listResult.diagnosis?.code || 'failed'),
        ...(deep && chatResult ? { chatOk: Boolean(chatResult.ok), chatElapsedMs: chatResult.elapsedMs || 0 } : {}),
      })
    } catch { /* 历史记录失败不影响检测结果 */ }
  }

  async function checkProfile(id, { deep = false, model = '', signal } = {}) {
    const profile = await profileStore.resolve(id)
    if (!profile.apiKey) return missingKeyResult()
    const listResult = rendererProbeResult(await probePayload({ ...profile, action: 'models' }, { signal }), profile.apiKey)
    let chatResult = null
    let chatModel = ''
    if (deep && listResult.ok && listResult.models?.length && !signal?.aborted) {
      chatModel = String(model || '').trim() || listResult.models[0]
      const raw = await probePayload({ ...profile, action: 'chat', model: chatModel }, { signal })
      chatResult = rendererProbeResult(raw, profile.apiKey)
    }
    const result = { ...listResult }
    if (deep) {
      result.deep = true
      result.chat = chatResult ? compactChat(chatResult) : null
      result.deepModel = chatModel || undefined
    }
    await recordHistory(id, listResult, chatResult, deep)
    return result
  }

  async function checkSingle(id, { action, model } = {}) {
    const profile = await profileStore.resolve(id)
    if (!profile.apiKey) return missingKeyResult()
    const result = rendererProbeResult(await probePayload({ ...profile, action, model }), profile.apiKey)
    if (action === 'models' && historyStore) {
      try {
        await historyStore.append(id, {
          ok: Boolean(result.ok),
          elapsedMs: result.elapsedMs || 0,
          modelCount: Array.isArray(result.models) ? result.models.length : 0,
          errorCode: result.ok ? undefined : (result.diagnosis?.code || 'failed'),
        })
      } catch { /* 历史记录失败不影响检测结果 */ }
    }
    return result
  }

  return { checkProfile, checkSingle }
}
