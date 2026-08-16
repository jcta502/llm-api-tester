import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { createHttpServer, listenWithRetry } from '../lib/http-server.mjs'
import { ProfileStore } from '../lib/profile-store.mjs'
import { HistoryStore } from '../lib/history-store.mjs'
import { SettingsStore } from '../lib/settings-store.mjs'

const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`sealed:${value}`),
  decryptString: value => value.toString().replace(/^sealed:/, ''),
}

const root = fileURLToPath(new URL('..', import.meta.url))

async function startFixture() {
  const upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'chat-a1' }, { id: 'chat-b2' }, { id: 'embed-c3' }] }))
    if (req.url === '/v1/chat/completions') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      return req.on('end', () => {
        const payload = JSON.parse(body || '{}')
        if (payload.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          setTimeout(() => res.write('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'), 15)
          setTimeout(() => res.end('data: [DONE]\n\n'), 45)
          return
        }
        res.end(JSON.stringify({ model: payload.model, choices: [{ message: { content: 'OK' } }] }))
      })
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`

  const directory = mkdtempSync(join(tmpdir(), 'llm-smoke-'))
  const profileStore = new ProfileStore({ filePath: join(directory, 'profiles.json'), encryption })
  const historyStore = new HistoryStore({ filePath: join(directory, 'history.json') })
  const settingsStore = new SettingsStore({ filePath: join(directory, 'settings.json') })
  const server = createHttpServer({
    root, profileStore, historyStore, settingsStore, themeHandler: null, token: '',
    updateHandler: async () => ({ current: '0.0.0', latest: null, hasUpdate: false }),
    backupExport: async () => { throw new Error('smoke: skip') },
    backupImport: async () => { throw new Error('smoke: skip') },
    onSettingsChanged: async () => {},
  })
  const port = await listenWithRetry(server, 0)
  return {
    url: `http://127.0.0.1:${port}`,
    upstreamUrl,
    profileStore,
    close: async () => {
      await new Promise(resolve => server.close(resolve))
      await new Promise(resolve => upstream.close(resolve))
    },
  }
}

async function withGlobals(url) {
  const window = new Window({ url })
  const html = await readFile(join(root, 'index.html'), 'utf8')
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] || ''
  window.document.body.innerHTML = body
  const previous = { document: global.document, window: global.window, localStorage: global.localStorage, location: global.location, history: global.history, EventSource: global.EventSource, fetch: global.fetch, navigator: global.navigator, Option: global.Option }
  global.document = window.document
  global.window = window
  global.localStorage = window.localStorage
  global.location = window.location
  global.history = window.history
  global.navigator = window.navigator
  global.Option = window.Option
  global.EventSource = class FakeEventSource { constructor() {} close() {} }
  global.fetch = (input, init) => window.fetch(String(input).startsWith('/') ? new URL(String(input), url).toString() : String(input), init)
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]
      else global[key] = value
    }
  }
  return { window, restore }
}

async function waitFor(predicate, timeoutMs = 8000, stepMs = 100) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
  return false
}

test('page renders profiles, fetches models, and completes a deep batch check', async () => {
  const fixture = await startFixture()
  let restore = null
  try {
    await fixture.profileStore.save({ name: 'Smoke-Good', group: '冒烟', provider: 'openai', baseUrl: `${fixture.upstreamUrl}/v1`, apiKey: 'secret', headers: { 'X-Title': 'smoke' } })

    const { window, restore: restoreGlobals } = await withGlobals(fixture.url)
    restore = restoreGlobals
    await import('../src/main.js')

    const document = window.document
    // 1) 配置库渲染：分组标题 + 卡片 + 健康区域初始为空
    assert.ok(await waitFor(() => document.querySelector('.profile-item')), '配置卡片应渲染')
    assert.equal(document.querySelector('.profile-group-title')?.textContent, '冒烟')
    assert.equal(document.getElementById('profileCount')?.textContent, '1 个配置')

    // 2) 编辑载入并获取模型列表（走已保存密钥路径）
    document.querySelector('button[data-action="edit"]').click()
    assert.equal(document.getElementById('profileName').value, 'Smoke-Good')
    document.getElementById('fetchModels').click()
    assert.ok(await waitFor(() => !document.getElementById('modelsCard').classList.contains('hidden')), '模型卡片应显示')
    assert.equal(document.getElementById('modelCount').textContent, '3 个模型')

    // 3) 模型搜索过滤
    const search = document.getElementById('modelSearch')
    search.value = 'chat'
    search.dispatchEvent(new window.Event('input', { bubbles: true }))
    const options = [...document.getElementById('modelSelect').options].filter(option => option.value).map(option => option.textContent)
    assert.deepEqual(options, ['chat-a1', 'chat-b2'])
    search.value = ''
    search.dispatchEvent(new window.Event('input', { bubbles: true }))

    // 4) 深度批量检测：勾选 + deep → 结果表出现真实调用列
    document.querySelector('input[data-action="select"]').click()
    const deep = document.getElementById('deepCheck')
    deep.checked = true
    document.getElementById('runBatch').click()
    assert.ok(await waitFor(() => document.querySelector('#batchResults table')), '批量结果表应渲染')
    assert.ok(await waitFor(() => document.getElementById('batchMessage').textContent.includes('批量检测完成')), '批量检测应完成')
    const headers = [...document.querySelectorAll('#batchResults th')].map(th => th.textContent)
    assert.ok(headers.includes('真实调用'), '深度检测应包含真实调用列')
    assert.ok(document.getElementById('batchResults').textContent.includes('可用 · '), '真实调用结果应显示可用')

    // 5) 检测历史徽标出现
    assert.ok(await waitFor(() => document.querySelector('.health-dot')), '历史健康圆点应渲染')
  } finally {
    restore?.()
    await fixture.close()
  }
})
