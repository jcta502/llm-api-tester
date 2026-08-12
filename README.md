# LLM API Tester

一个本地运行的小工具，用于快速验证 OpenAI 兼容 API 的 Base URL、API Key 和模型是否真正可用。

## 功能

- 调用 `GET /models` 获取当前 Key 可访问的模型列表
- 选择模型后调用 `POST /chat/completions` 进行最小实际测试
- 清晰显示 HTTP 状态、耗时、返回模型、Token 用量和错误原因
- 导出不包含 API Key 的 JSON 检测报告

## 启动

```powershell
cd F:\common_project\api-test
npm run dev
```

然后在浏览器打开 <http://127.0.0.1:4173>。

## 安全说明

API Key 只在当前页面与本地 Node 服务的内存中传递，服务不会保存 Key，也不会记录请求内容。请勿将 Key 填入任何公开部署的版本。

## 当前适配范围

首版面向 OpenAI 兼容接口，预期地址形如 `https://example.com/v1`。支持大多数实现 `/models` 和 `/chat/completions` 的官方 API 或中转 API。
