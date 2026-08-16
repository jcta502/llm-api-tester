import { $, setStatus, saveBlob } from './dom.js'
import { isDesktop } from './api.js'
import { loadProfiles } from './profiles.js'

$('themeSelect').addEventListener('change', async () => { const theme = $('themeSelect').value; localStorage.setItem('theme', theme); document.documentElement.dataset.theme = theme; await window.llmApi?.setTheme?.(theme) })
const savedTheme = localStorage.getItem('theme') || 'system'; $('themeSelect').value = savedTheme; document.documentElement.dataset.theme = savedTheme; window.llmApi?.setTheme?.(savedTheme)

window.llmApi.profiles.capabilities().then(capability => {
  if (!capability.storeEnabled) { $('saveProfile').disabled = true; $('securityText').textContent = '当前为纯浏览器开发模式，不提供配置库；启动桌面应用后即可保存并共享加密配置。' }
  else if (!capability.secureStorage) { $('saveProfile').disabled = true; $('securityText').textContent = '系统安全存储当前不可用，因此已禁用密钥保存。' }
  else $('importProfiles').disabled = false
}).catch(() => { $('saveProfile').disabled = true; $('securityText').textContent = '无法连接本地服务；请确认桌面应用正在运行。' })

window.llmApi.getSettings?.().then(settings => {
  $('proxyUrl').value = settings?.proxyUrl || ''
  $('scheduleEnabled').checked = Boolean(settings?.scheduleEnabled)
  $('scheduleMinutes').value = String(settings?.scheduleMinutes || 30)
}).catch(() => {})

window.llmApi.checkUpdate?.().then(info => {
  if (!info?.hasUpdate) return
  const badge = $('updateBadge')
  badge.textContent = `新版本 v${info.latest}`
  badge.title = `当前 v${info.current}，点击查看发布页`
  badge.classList.remove('hidden')
  badge.addEventListener('click', () => window.llmApi.openRelease?.())
}).catch(() => {})

$('saveProxy').addEventListener('click', async () => {
  const button = $('saveProxy'); button.disabled = true
  try { const saved = await window.llmApi.setSettings({ proxyUrl: $('proxyUrl').value.trim() }); $('proxyUrl').value = saved.proxyUrl || ''; setStatus('success', '代理设置已保存', saved.proxyUrl ? `后续检测请求将通过 ${saved.proxyUrl} 发送。` : '已恢复直连。') } catch (error) { setStatus('error', '代理设置无效', error.message || '请检查代理地址格式。') } finally { button.disabled = false }
})

$('saveSchedule').addEventListener('click', async () => {
  const button = $('saveSchedule'); button.disabled = true
  try {
    const saved = await window.llmApi.setSettings({ scheduleEnabled: $('scheduleEnabled').checked, scheduleMinutes: Number($('scheduleMinutes').value) })
    $('scheduleEnabled').checked = Boolean(saved.scheduleEnabled)
    $('scheduleMinutes').value = String(saved.scheduleMinutes)
    setStatus('success', '定时设置已保存', saved.scheduleEnabled ? `每 ${saved.scheduleMinutes} 分钟自动检测一次，状态变化时会通知。` : '已关闭定时检测。')
  } catch (error) { setStatus('error', '定时设置无效', error.message || '请检查间隔设置。') } finally { button.disabled = false }
})

$('backupExportBtn').addEventListener('click', async () => {
  const passphrase = $('backupPassphrase').value
  if (!passphrase || passphrase.length < 6) return setStatus('error', '备份口令太短', '请输入至少 6 位的备份口令。')
  const button = $('backupExportBtn'); button.disabled = true
  try {
    const blob = await window.llmApi.backupExport(passphrase)
    saveBlob(JSON.stringify(blob, null, 2), 'application/json', 'llm-api-backup.json')
    $('backupPassphrase').value = ''
    setStatus('success', '加密备份已导出', '文件包含全部配置、密钥与请求头，请妥善保管备份口令。')
  } catch (error) { setStatus('error', '备份失败', error.message || '无法完成备份。') } finally { button.disabled = false }
})

$('backupImportBtn').addEventListener('click', () => $('backupFile').click())
$('backupFile').addEventListener('change', async event => {
  const file = event.target.files?.[0]; event.target.value = ''
  if (!file) return
  const passphrase = $('backupPassphrase').value
  if (!passphrase) return setStatus('error', '缺少备份口令', '请先在上方输入导出备份时使用的口令。')
  try {
    const blob = JSON.parse(await file.text())
    const restored = await window.llmApi.backupImport(blob, passphrase)
    $('backupPassphrase').value = ''
    await loadProfiles()
    setStatus(restored.imported ? 'success' : 'error', `恢复完成：${restored.imported}/${restored.total} 个配置`, '已恢复的配置保留原有密钥与请求头，可直接检测。', restored.errors?.join(' | '))
  } catch (error) { setStatus('error', '恢复备份失败', error.message || '无法读取备份文件。') }
})

if (isDesktop) {
  window.llmApi.localEndpoint?.().then(endpoint => {
    if (!endpoint?.url) return
    const button = $('openInBrowser')
    button.classList.remove('hidden')
    button.title = `本地地址 http://127.0.0.1:${endpoint.port}（首次请从这里打开以获取访问令牌）`
    button.addEventListener('click', () => window.llmApi.openInBrowser())
  }).catch(() => { /* endpoint unavailable */ })
}
