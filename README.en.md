# LLM API Tester

A local desktop tool for validating LLM API credentials, listing models, checking real model calls, and comparing multiple endpoints side by side. Runs entirely on your own machine; API keys are encrypted by the operating system and never leave the app process.

[![English](https://img.shields.io/badge/English-Current_language-brightgreen)](README.en.md) [![简体中文](https://img.shields.io/badge/简体中文-点击切换-blue)](README.md)

## Features

### Configuration library
- Saves multiple endpoint profiles with OS-backed encryption for API keys and custom headers
- Groups profiles, duplicates them in one click, and imports/exports key-free profile bundles
- Per-profile check history shown as health dots on each card
- When editing a saved profile, click **Show** to decrypt and reveal the stored key in plaintext (decrypted only for editing, never written to exports or backups)
- Click the blank area of a profile bar to expand/collapse its model list inline
- Checks for new GitHub releases and links to the release page

### Single-endpoint checks
- Lists models available to the current key, with instant search and one-click copy
- Sends a minimal test request to a selected model and shows HTTP status, latency, resolved endpoint, returned model, token usage, and error details
- Measures streaming TTFT and full response time, with 1/3/5-run averages and characters-per-second throughput
- Diagnoses DNS, TLS, timeout, authentication, permission, rate-limit, and upstream errors
- Exports a sanitized JSON report (API keys, raw payloads, and response content excluded)

### Compatibility check
- One-click deep check per profile: model list, non-streaming chat, and streaming
- Renders an **agent config card** (Base URL, model name, auth header, streaming / schema-compliance verdicts) ready to copy into an agent's model settings
- Collapsible raw upstream-response viewer for diagnosing non-compliant gateways

### Batch checks and comparison
- Up to three concurrent profile checks with live progress and cancellation
- Optional deep batch checks that perform a minimal real chat call after listing models
- Retries only the failed endpoints of the last batch run
- Sorts results by availability, latency, model count, or name
- Exports batch reports as JSON or UTF-8 CSV

### System and automation
- Optional global HTTP(S) proxy (CONNECT tunnel) for all probe traffic
- Optional per-profile custom request headers for gateways that require them
- Optional scheduled checks with system notifications on availability changes
- Passphrase-encrypted backups so keys survive reinstallations or machine moves
- System tray: closing the window hides to tray; right-click for open-in-browser / quit
- Light, dark, and system-following themes

### Supported protocols
| Protocol | List models | Test call |
| --- | --- | --- |
| OpenAI-compatible | `GET /models` | `POST /chat/completions` |
| Anthropic | `GET /v1/models` | `POST /v1/messages` |
| Gemini | `GET /v1beta/models` | `POST /v1beta/models/{model}:generateContent` |

The OpenAI-compatible option requires a Base URL such as `https://example.com/v1`. Anthropic and Gemini prefill official API roots but also accept a compatible custom gateway URL. The tool automatically normalizes root URLs, `/v1`, `/models`, and full completion URLs, and falls back between OpenAI Chat Completions and Responses API when appropriate.

## For users

Just download a build from [Releases](https://github.com/jcta502/llm-api-tester/releases), pick the latest version, and run it. No installation and no Node.js / npm needed. Two Windows builds are published with each release:

- **ZIP build** (`LLM API Tester-<version>-win.zip`) — extract once and run `LLM API Tester.exe`. Starts fast because the Electron runtime does not unpack itself on every launch. Recommended for normal use.
- **Portable EXE** (`LLM-API-Tester-<version>-portable.exe`) — a single self-contained file. Convenient to send as one file, but starts more slowly because it unpacks the runtime on each launch.

Both contain the full feature set. After launch it opens its own window and also starts a local web server on `http://127.0.0.1:4173`, so the desktop window and a browser page share one process, one profile store, and one set of encrypted keys. Use the **Open in browser** button in the app header to open the browser view.

## For developers

You only need the commands below if you want to modify the code or run from source. End users do not need Node.js or npm — the release builds already bundle everything.

### Run from source

```powershell
npm install
npm run desktop
```

This launches the full desktop app (with profile store, encrypted keys, etc.) from source.

### Browser-only dev mode

```powershell
npm install
npm run dev
```

Open <http://127.0.0.1:4173> in a browser. This is a developer-only mode with **no profile store**: it can run one-off checks with a manually entered key but cannot save configurations. It is meant only for frontend development.

Notes:

- The server binds to `127.0.0.1` only, so it is never exposed to your network.
- If port 4173 is busy the app takes the next free port and logs the new address; update your bookmark in that case.
- Launching the app twice focuses the existing window instead of starting a second server, which keeps the bookmarked port stable.
- Closing the window hides the app to the system tray; use the tray menu to fully quit.

## Build Windows packages

```powershell
# Fast-starting no-install ZIP build
npm run dist:fast

# Single-file portable build
npm run dist:win

# Both at once
npm run dist:all
```

## Automated releases

Pushing a version tag such as `v0.4.0` triggers `.github/workflows/release.yml`. GitHub Actions runs the tests, builds both Windows packages (ZIP + portable EXE), uploads workflow artifacts, and attaches them to the matching GitHub Release with auto-generated release notes.

## Development

- `npm test` — unit tests plus a happy-dom UI smoke test that drives the real page (profile list, model fetch, search, deep batch check) against an in-process mock upstream and API server.
- `npm run lint` — ESLint over `src/`, `lib/`, `electron/`, and tests.
- `npm run check` — syntax check for every module.

The renderer is split into ES modules under `src/`: `api.js` (browser API client), `state.js` (shared state), `dom.js` (rendering helpers), `form.js` (single-endpoint checks), `profiles.js` (profile library), `batch.js` (batch checks), `settings.js` (theme, proxy, schedule, backup, update badge), wired together by `main.js`.

## Security

In the desktop app, saved API keys are encrypted through Electron `safeStorage` (Windows uses the current user's OS-protected storage) and are decrypted only in the main process for requests. The renderer never receives a saved key, except the explicit **Show** action during editing, which decrypts into the input field only. Custom request headers are encrypted the same way and are excluded from profile exports. Reports use explicit field whitelists and exclude keys, raw upstream payloads, and response content.

The local web server applies the same rule: the browser receives profile metadata and `hasKey`, never the key itself, and saved-key checks are resolved inside the app process. It also enforces several local-only guards:

- Requests with a foreign `Host` header are rejected, which blocks DNS-rebinding attacks from other web pages.
- API routes require a persistent access token stored under the app's user data directory; page assets load without it so bookmarks work.
- Only `index.html`, `src/`, `lib/`, and `public/` are served, so project files such as `package.json` and `node_modules` stay unreachable.

Browser development mode (`npm run dev`) has no profile store and never persists API keys.
