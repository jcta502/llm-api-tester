# LLM API Tester

A local tool for quickly validating LLM API credentials, listing models, and confirming that a selected model can make a real response.

## Features

- Supports OpenAI-compatible, Anthropic Messages, and Google Gemini APIs
- Lists models available to the current API key
- Sends a minimal test request to a selected model
- Shows HTTP status, latency, returned model, token usage, and error details
- Exports a JSON report with API keys excluded

## Run locally

```powershell
cd F:\common_project\api-test
npm run dev
```

Open <http://127.0.0.1:4173> in a browser.

## Security

API keys are only held in memory for the active request. The local service does not save keys or request content, and export files exclude the key. Do not put keys into a publicly deployed instance.

## Supported protocols

| Protocol | List models | Test call |
| --- | --- | --- |
| OpenAI-compatible | `GET /models` | `POST /chat/completions` |
| Anthropic | `GET /v1/models` | `POST /v1/messages` |
| Gemini | `GET /v1beta/models` | `POST /v1beta/models/{model}:generateContent` |

The OpenAI-compatible option requires a Base URL such as `https://example.com/v1`. Anthropic and Gemini prefill official API roots but also accept a compatible custom gateway URL.
