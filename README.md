# LLM API Tester

A local tool for quickly validating LLM API credentials, listing models, and confirming that a selected model can make a real response.

## Features

- Saves multiple endpoint profiles with OS-backed encryption for API keys (and custom headers)
- Groups profiles, duplicates them in one click, and imports/exports key-free profile bundles
- Keeps a per-profile check history and shows recent health dots on each profile card
- Optional deep batch checks that perform a minimal real chat call after listing models
- Retries only the failed endpoints of the last batch run
- Optional global HTTP(S) proxy for all probe traffic (CONNECT tunnel)
- Optional per-profile custom request headers for gateways that require them
- Optional scheduled checks with system notifications on availability changes
- Passphrase-encrypted backups so keys survive reinstallations or machine moves
- Checks for new GitHub releases and links to the release page
- Serves the same UI to the desktop window and to your browser from one running app
- Runs up to three profile checks concurrently, with live progress and cancellation
- Sorts batch results by availability, latency, model count, or name
- Exports sanitized batch reports as JSON or UTF-8 CSV
- Includes light, dark, and system-following themes
- Supports OpenAI-compatible, Anthropic Messages, and Google Gemini APIs
- Automatically normalizes root URLs, `/v1`, `/models`, and full completion URLs
- Falls back between OpenAI Chat Completions and Responses API when appropriate
- Lists models available to the current API key, with instant search and one-click copy
- Sends a minimal test request to a selected model
- Measures streaming TTFT and full response time, with 1/3/5-run averages and characters-per-second throughput
- Diagnoses DNS, TLS, timeout, authentication, permission, rate-limit, and upstream errors
- Shows HTTP status, latency, resolved endpoint, returned model, token usage, and error details
- Exports a JSON report with API keys excluded

## Use it from the desktop app and the browser

Start the desktop app (`npm run desktop`, or the packaged EXE). It opens its own
window and also starts a local web server on `http://127.0.0.1:4173`, so both
front ends share one process, one profile store, and one set of encrypted keys.

To open the browser view, use the "在浏览器中打开" button in the app header. It
launches your default browser with the required access token, which the page
stores locally. After that first visit you can bookmark the plain
`http://127.0.0.1:4173` address: closing and reopening the tab, or launching it
from the bookmarks bar, keeps working as long as the desktop app is running.

Anything saved in one view appears in the other. If the desktop app is not
running, the page cannot load and API calls fail; start the app and reload.

Notes:

- The server binds to `127.0.0.1` only, so it is never exposed to your network.
- If port 4173 is busy the app takes the next free port and logs the new
  address; update your bookmark in that case.
- Launching the app twice focuses the existing window instead of starting a
  second server, which keeps the bookmarked port stable.

## Run locally

```powershell
cd F:\common_project\api-test
npm run dev
```

Open <http://127.0.0.1:4173> in a browser. This browser-only mode has no profile
store, so it can run one-off checks with a manually entered key but cannot save
configurations. Use the desktop app for the full feature set.

## Windows desktop builds

```powershell
# Fast-starting no-install ZIP build
npm run dist:fast

# Single-file portable build
npm run dist:win
```

For normal distribution, prefer the ZIP build: extract it once and run `LLM API Tester.exe`. It starts much faster because the Electron runtime does not need to unpack itself on every launch. The single-file portable EXE is convenient to send as one file, but it starts more slowly by design.

## Automated releases

Pushing a version tag such as `v0.3.0` triggers `.github/workflows/release.yml`. GitHub Actions runs the tests, builds both Windows packages, uploads workflow artifacts, and attaches them to the matching GitHub Release.

## Security

In the desktop app, saved API keys are encrypted through Electron `safeStorage` (Windows uses the current user's OS-protected storage) and are decrypted only in the main process for requests. The renderer never receives a saved key. Custom request headers are encrypted the same way and are excluded from profile exports. Reports use explicit field whitelists and exclude keys, raw upstream payloads, and response content.

The local web server applies the same rule: the browser receives profile metadata and `hasKey`, never the key itself, and saved-key checks are resolved inside the app process. It also enforces several local-only guards:

- Requests with a foreign `Host` header are rejected, which blocks DNS-rebinding attacks from other web pages.
- API routes require a persistent access token stored under the app's user data directory; page assets load without it so bookmarks work.
- Only `index.html`, `src/`, `lib/`, and `public/` are served, so project files such as `package.json` and `node_modules` stay unreachable.

Browser development mode (`npm run dev`) has no profile store and never persists API keys.

## Supported protocols

| Protocol | List models | Test call |
| --- | --- | --- |
| OpenAI-compatible | `GET /models` | `POST /chat/completions` |
| Anthropic | `GET /v1/models` | `POST /v1/messages` |
| Gemini | `GET /v1beta/models` | `POST /v1beta/models/{model}:generateContent` |

The OpenAI-compatible option requires a Base URL such as `https://example.com/v1`. Anthropic and Gemini prefill official API roots but also accept a compatible custom gateway URL.
