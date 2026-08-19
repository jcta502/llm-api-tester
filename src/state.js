export const providerInfo = {
  openai: { title: 'OpenAI 兼容接口', defaultUrl: '', placeholder: 'https://api.example.com/v1', help: '填写根地址或包含 /v1 的地址，工具会自动补全接口路径。', keyPlaceholder: 'sk-...' },
  anthropic: { title: 'Anthropic Messages 接口', defaultUrl: 'https://api.anthropic.com', placeholder: 'https://api.anthropic.com', help: '默认使用 Anthropic 官方地址，也支持兼容的自定义网关。', keyPlaceholder: 'sk-ant-...' },
  gemini: { title: 'Google Gemini 接口', defaultUrl: 'https://generativelanguage.googleapis.com', placeholder: 'https://generativelanguage.googleapis.com', help: '默认使用 Gemini 官方地址，也支持兼容的自定义网关。', keyPlaceholder: 'AIza...' },
}

export const state = {
  provider: 'openai', models: [], listResult: null, probeResult: null, providerUrls: {},
  editingId: null, editingHasKey: false, editingHasHeaders: false, profiles: [], history: {}, selectedIds: new Set(),
  batchRows: [], batchJobId: null, batchTotal: 0, batchCompleted: 0, lastBatchDeep: false,
  detail: {}, editingKeyVisible: false,
}
