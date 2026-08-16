// 入口：api.js 必须最先加载（浏览器模式下注入 window.llmApi 兜底实现）。
import './api.js'
import './form.js'
import './profiles.js'
import './batch.js'
import './settings.js'
import { isDesktop } from './api.js'
import { setStatus } from './dom.js'
import { loadProfiles } from './profiles.js'

if (!isDesktop) {
  const hasToken = Boolean(localStorage.getItem('localToken'))
  if (!hasToken) setStatus('error', '缺少访问令牌', '请从桌面应用的“在浏览器中打开”入口进入一次，之后即可直接使用收藏栏地址。')
}

loadProfiles()
