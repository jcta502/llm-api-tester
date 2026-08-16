import { batchReport, batchReportCsv } from '../lib/report.mjs'
import { $, escapeHtml, saveBlob, errorMessage, providerLabel } from './dom.js'
import { providerInfo, state } from './state.js'
import { loadProfiles } from './profiles.js'

function sortedBatchRows() {
  const rows = [...state.batchRows]; const sort = $('sortBatch').value
  if (sort === 'original') return rows.sort((a, b) => a.index - b.index)
  if (sort === 'status') return rows.sort((a, b) => Number(Boolean(b.result?.ok)) - Number(Boolean(a.result?.ok)) || a.index - b.index)
  if (sort === 'latency') return rows.sort((a, b) => (a.result?.elapsedMs ?? Infinity) - (b.result?.elapsedMs ?? Infinity) || a.index - b.index)
  if (sort === 'models') return rows.sort((a, b) => (b.result?.models?.length ?? -1) - (a.result?.models?.length ?? -1) || a.index - b.index)
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.index - b.index)
}

function updateRetryButton() {
  const failedIds = state.batchRows.filter(row => row.result && !row.result.ok && row.result.diagnosis?.code !== 'cancelled').map(row => row.id)
  $('retryFailed').disabled = !failedIds.length || Boolean(state.batchJobId)
  $('retryFailed').textContent = failedIds.length ? `仅重试失败项（${failedIds.length}）` : '仅重试失败项'
}

function renderBatch() {
  if (!state.batchRows.length) { $('batchResults').classList.add('hidden'); $('batchSummary').innerHTML = ''; updateRetryButton(); return }
  const deep = state.lastBatchDeep
  const rows = sortedBatchRows(); $('batchResults').classList.remove('hidden')
  const chatCell = row => {
    const chat = row.result?.chat
    if (chat) return `<td class="${chat.ok ? 'batch-ok' : 'batch-fail'}">${chat.ok ? `可用 · ${chat.elapsedMs} ms` : escapeHtml(chat.error || '调用失败')}</td>`
    return `<td>${row.state === 'pending' || row.state === 'running' ? '—' : row.result?.ok ? '未执行' : '—'}</td>`
  }
  $('batchResults').innerHTML = `<table><thead><tr><th>配置</th><th>服务商</th><th>状态</th>${deep ? '<th>真实调用</th>' : ''}<th>模型数</th><th>延迟</th><th>接口 / 原因</th></tr></thead><tbody>${rows.map(row => { const result = row.result; const stateLabel = row.state === 'pending' ? '等待中' : row.state === 'running' ? '检测中…' : result?.ok ? '可用' : result?.diagnosis?.code === 'cancelled' ? '已取消' : `失败${result?.status ? ` · ${result.status}` : ''}`; return `<tr><td><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.baseUrl || providerInfo[row.provider].defaultUrl)}</small></td><td>${escapeHtml(providerLabel(row.provider))}</td><td class="${result?.ok ? 'batch-ok' : row.state === 'pending' || row.state === 'running' ? 'batch-wait' : 'batch-fail'}">${escapeHtml(stateLabel)}</td>${deep ? chatCell(row) : ''}<td>${result?.ok ? result.models.length : '—'}</td><td>${Number.isFinite(result?.elapsedMs) ? `${result.elapsedMs} ms` : '—'}</td><td><code>${escapeHtml(result?.ok ? result.resolvedEndpoint || result.url : result ? errorMessage(result) : '等待开始')}</code></td></tr>` }).join('')}</tbody></table>`
  const finished = state.batchRows.filter(row => row.result); const passed = finished.filter(row => row.result.ok).length; const failed = finished.filter(row => !row.result.ok && row.result.diagnosis?.code !== 'cancelled').length
  const chatFailed = deep ? finished.filter(row => row.result.ok && row.result.chat && !row.result.chat.ok).length : 0
  $('batchSummary').innerHTML = `<span>${state.batchCompleted}/${state.batchTotal || state.batchRows.length} 已完成</span><span class="positive">${passed} 可用</span><span class="negative">${failed} 失败</span>${deep && chatFailed ? `<span class="negative">${chatFailed} 个仅列表可用</span>` : ''}`
  updateRetryButton()
}

function updateBatchProgress() { const ratio = state.batchTotal ? Math.min(state.batchCompleted / state.batchTotal, 1) : 0; $('batchProgress').value = ratio * 100 }

export async function runBatch(targetIds) {
  const deep = $('deepCheck').checked
  const model = $('deepModel').value.trim()
  const ids = targetIds || [...state.selectedIds]
  if (!ids.length) { $('batchMessage').textContent = '请先从配置库中选择至少一个端点。'; return }
  state.batchJobId = crypto.randomUUID(); state.lastBatchDeep = deep; state.batchTotal = ids.length; state.batchCompleted = 0
  state.batchRows = ids.map((id, index) => { const profile = state.profiles.find(item => item.id === id); return { ...profile, index, state: 'pending', result: null } })
  $('runBatch').disabled = true; $('cancelBatch').classList.remove('hidden'); $('batchProgress').classList.remove('hidden'); $('batchMessage').textContent = deep ? `正在检测 ${ids.length} 个端点（含真实调用），并发上限为 3…` : `正在检测 ${ids.length} 个端点，并发上限为 3…`; $('exportBatchJson').disabled = true; $('exportBatchCsv').disabled = true
  renderBatch(); updateBatchProgress()
  const progressChannel = window.llmApi.profiles.onProgress(({ jobId, id, result }) => { if (jobId !== state.batchJobId) return; const row = state.batchRows.find(item => item.id === id); if (!row || row.result) return; row.result = result; row.state = result.ok ? 'success' : result.diagnosis?.code === 'cancelled' ? 'cancelled' : 'failed'; state.batchCompleted += 1; updateBatchProgress(); renderBatch() })
  try {
    progressChannel?.subscribe?.(state.batchJobId)
    const result = await window.llmApi.profiles.run({ jobId: state.batchJobId, ids, concurrency: 3, deep, model })
    result.results?.forEach((item, index) => {
      if (!item || state.batchRows[index]?.result) return
      state.batchRows[index].result = item
      state.batchRows[index].state = item.ok ? 'success' : item.diagnosis?.code === 'cancelled' ? 'cancelled' : 'failed'
      state.batchCompleted += 1
    })
    if (result.cancelled) {
      for (const row of state.batchRows.filter(item => !item.result)) { row.state = 'cancelled'; row.result = { ok: false, status: 0, diagnosis: { code: 'cancelled', message: '检测已取消' } } }
      state.batchCompleted = state.batchRows.length; $('batchMessage').textContent = `检测已取消，已完成 ${result.completed} 个请求。`
    } else {
      const usable = state.batchRows.filter(row => row.result?.ok).length
      const chatReady = deep ? state.batchRows.filter(row => row.result?.ok && row.result?.chat?.ok).length : 0
      $('batchMessage').textContent = deep ? `批量检测完成：${usable}/${ids.length} 个端点列表可用，其中 ${chatReady} 个真实调用成功。` : `批量检测完成：${usable}/${ids.length} 个端点可用。`
    }
  } catch (error) { $('batchMessage').textContent = error.message || '批量检测执行失败。' }
  finally { state.batchJobId = null; progressChannel?.close?.(); $('runBatch').disabled = false; $('cancelBatch').classList.add('hidden'); $('exportBatchJson').disabled = !state.batchRows.some(row => row.result); $('exportBatchCsv').disabled = !state.batchRows.some(row => row.result); updateBatchProgress(); renderBatch(); loadProfiles().catch(() => {}) }
}

$('runBatch').addEventListener('click', () => runBatch())
$('retryFailed').addEventListener('click', () => {
  const failedIds = state.batchRows.filter(row => row.result && !row.result.ok && row.result.diagnosis?.code !== 'cancelled').map(row => row.id)
  if (failedIds.length) runBatch(failedIds)
})
$('cancelBatch').addEventListener('click', async () => { if (!state.batchJobId) return; $('cancelBatch').disabled = true; $('batchMessage').textContent = '正在取消尚未完成的检测…'; await window.llmApi.profiles.cancel(state.batchJobId); $('cancelBatch').disabled = false })
$('sortBatch').addEventListener('change', renderBatch)
$('exportBatchJson').addEventListener('click', () => saveBlob(JSON.stringify({ generatedAt: new Date().toISOString(), results: batchReport(sortedBatchRows()) }, null, 2), 'application/json', 'llm-api-batch-report.json'))
$('exportBatchCsv').addEventListener('click', () => saveBlob(batchReportCsv(sortedBatchRows()), 'text/csv;charset=utf-8', 'llm-api-batch-report.csv'))
