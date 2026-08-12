# LLM API Tester

A local tool for quickly validating LLM API credentials, listing models, and confirming that a selected model can make a real response.

## Features

- Supports OpenAI-compatible, Anthropic Messages, and Google Gemini APIs
- Automatically normalizes root URLs, `/v1`, `/models`, and full completion URLs
- Falls back between OpenAI Chat Completions and Responses API when appropriate
- Lists models available to the current API key
- Sends a minimal test request to a selected model
- Measures streaming time to first token (TTFT) and full response time
- Diagnoses DNS, TLS, timeout, authentication, permission, rate-limit, and upstream errors
- Shows HTTP status, latency, resolved endpoint, returned model, token usage, and error details
- Exports a JSON report with API keys excluded

## Run locally

```powershell
cd F:\common_project\api-test
npm run dev
```

Open <http://127.0.0.1:4173> in a browser.

## Windows desktop builds

```powershell
# Fast-starting no-install ZIP build
npm run dist:fast

# Single-file portable build
npm run dist:win
```

For normal distribution, prefer the ZIP build: extract it once and run `LLM API Tester.exe`. It starts much faster because the Electron runtime does not need to unpack itself on every launch. The single-file portable EXE is convenient to send as one file, but it starts more slowly by design.

## Automated releases

Pushing a version tag such as `v0.2.0` triggers `.github/workflows/release.yml`. GitHub Actions runs the tests, builds both Windows packages, uploads workflow artifacts, and attaches them to the matching GitHub Release.

## Security

API keys are only held in memory for the active request. The local service does not save keys or request content, and export files exclude the key. Do not put keys into a publicly deployed instance.

## Supported protocols

| Protocol | List models | Test call |
| --- | --- | --- |
| OpenAI-compatible | `GET /models` | `POST /chat/completions` |
| Anthropic | `GET /v1/models` | `POST /v1/messages` |
| Gemini | `GET /v1beta/models` | `POST /v1beta/models/{model}:generateContent` |

The OpenAI-compatible option requires a Base URL such as `https://example.com/v1`. Anthropic and Gemini prefill official API roots but also accept a compatible custom gateway URL.
