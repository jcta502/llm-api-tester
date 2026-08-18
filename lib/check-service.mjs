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

  // agentBaseFrom strips the action path so what remains is the base an agent
  // should be configured with: https://host/v1/chat/completions -> https://host/v1
  function agentBaseFrom(endpoint) {
    if (!endpoint) return ''
    return String(endpoint).replace(/\/(?:chat\/completions|responses|messages|models)\/?$/i, '')
  }

  function authHeaderFor(provider) {
    if (provider === 'anthropic') return 'x-api-key: <key>'
    if (provider === 'gemini') return 'URL 参数 ?key=<key>'
    return 'Authorization: Bearer <key>'
  }

  async function checkCompatibility(id, { signal } = {}) {
    const profile = await profileStore.resolve(id)
    if (!profile.apiKey) {
      return { ok: false, error: '该配置没有保存密钥。', diagnosis: { code: 'missing_key', message: '缺少已保存的密钥', hint: '编辑配置并重新输入 API Key。' } }
    }
    const listResult = rendererProbeResult(await probePayload({ ...profile, action: 'models' }, { signal }), profile.apiKey)
    const models = listResult.ok ? (listResult.models || []) : []
    const model = models[0] || ''

    let chatResult = null
    if (model && !signal?.aborted) {
      chatResult = rendererProbeResult(await probePayload({ ...profile, action: 'chat', model }, { signal }), profile.apiKey)
    }
    let streamResult = null
    if (model && !signal?.aborted) {
      streamResult = rendererProbeResult(await probePayload({ ...profile, action: 'stream', model }, { signal }), profile.apiKey)
    }

    await recordHistory(id, listResult, null, false)

    const streamOk = streamResult ? (streamResult.ok && Number(streamResult.chunks) > 0) : null
    const endpoint = chatResult?.resolvedEndpoint || listResult.resolvedEndpoint || ''
    return {
      ok: Boolean(listResult.ok),
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      resolvedEndpoint: endpoint,
      models: {
        ok: Boolean(listResult.ok),
        count: models.length,
        first: model || null,
        error: listResult.ok ? null : (listResult.diagnosis?.message || listResult.error || '获取失败'),
      },
      chat: chatResult ? {
        ok: Boolean(chatResult.ok),
        status: chatResult.status,
        elapsedMs: chatResult.elapsedMs,
        schemaOk: chatResult.schemaOk ?? null,
        schemaIssue: chatResult.schemaIssue || null,
        raw: chatResult.raw ?? null,
        error: chatResult.ok ? null : (chatResult.diagnosis?.message || chatResult.error || '调用失败'),
      } : null,
      stream: streamResult ? {
        ok: streamOk,
        status: streamResult.status,
        elapsedMs: streamResult.elapsedMs,
        ttftMs: streamResult.ttftMs ?? null,
        chunks: Number(streamResult.chunks) || 0,
        raw: streamResult.rawText ?? null,
        error: streamResult.ok ? null : (streamResult.diagnosis?.message || streamResult.error || '流式请求失败'),
        issue: streamResult.ok && streamOk === false ? '接口返回成功但未收到任何流式增量，智能体会一直等待。' : null,
      } : null,
      agent: {
        baseUrl: agentBaseFrom(endpoint),
        model: model || null,
        authHeader: authHeaderFor(profile.provider),
        streamSupported: streamOk,
        schemaOk: chatResult ? (chatResult.schemaOk ?? null) : null,
      },
    }
  }

  return { checkProfile, checkSingle, checkCompatibility }
}
