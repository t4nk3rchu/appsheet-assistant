# AppSheet Assistant — Firefox Port (Design)

**Date:** 2026-07-19
**Status:** Approved for planning
**Goal:** Reverse-engineer the Chrome extension *"Assistant for AppSheet — by Hoadata"* (v1.53.5) and rebuild it as a clean, open-source, cross-browser (Firefox + Chrome) extension that the author maintains long-term.

---

## 1. Context

- **Source material:** Only the compiled/minified Chrome Web Store build is available (no original source).
- **Motivation:** User's primary browser is Firefox; existing Chrome-extension shims for Firefox have poor compatibility.
- **Approach chosen:** *Partial reverse-engineer + clean rewrite* — understand the architecture, decompile only what's needed, rewrite as clean typed modules.
- **Distribution:** Public, open source (MIT), with credit to the original author (Hoadata).
- **Maintenance:** Long-term, maintained by the user.

### What the original does
An in-editor AI assistant for the AppSheet app editor: auto-generates columns/views/actions/format rules, validates schema, backs up config before writes, dark mode, Ctrl+K palette, and supports 5 AI providers (OpenAI, Google Gemini, DeepSeek, Moonshot, Alibaba DashScope). It never auto-saves — every change is user-confirmed, with a config backup offered first.

---

## 2. Architecture & the four moving parts

| Part | Original file | Role | Firefox risk |
|------|---------------|------|-------------|
| Background worker | `assets/bg.js` | Listens for `toggle-panel` command, relays to content script | 🟢 Low |
| Content loader (isolated world) | `assets/content.ts-loader-*.js` + `content.ts-*.js` | Mounts UI, message hub, AI `fetch()`, schema/backup logic | 🔴 High (dynamic import) |
| Bridge (MAIN world) | `assets/main-world.ts-*.js` | Reaches `window.currentApp()` + React internals in page context | 🟡 Medium (`world: "MAIN"`) |
| Popup / options UI (React) | `assets/index-*.js` + CSS | Settings, provider/API-key config | 🟢 Low |

### How the original reaches AppSheet internals
The MAIN-world bridge runs in the page's own JS context, so it can call the undocumented `window.currentApp()` (returns `appId`, `appName`, `appTemplate`) and manipulate AppSheet's React components by reading `__reactProps$` / `__reactFiber$` off DOM nodes and invoking their `onChange`/`onBlur` handlers (the `setFormatColumns`/SFC routine). The isolated content script talks to the bridge via `window.postMessage` with a tagged protocol (`__hoc_appsheet_request` / `__hoc_appsheet_response`).

---

## 3. Critical Chrome → Firefox compatibility gaps

### 3.1 Dynamic `import()` in content scripts — **must remove**
The loader does `await import(chrome.runtime.getURL("assets/content.ts-*.js"))`. Firefox's content-script sandbox cannot do dynamic `import()`. **Decision:** eliminate it — the import fires immediately anyway (it's a Vite code-splitting artifact, not real lazy-loading). Bundle the content layer as a **single file**. Keep the `chrome.runtime.id` context-invalidation guard at the top; drop the perf timing. The popup may still code-split freely (normal web page, no sandbox limits).

### 3.2 `world: "MAIN"` content scripts — **target Firefox 128+**
Declarative `world: "MAIN"` is supported in Firefox 128+ (mid-2024). **Decision:** target 128+ and use native `world: "MAIN"` rather than the fragile `<script>`-tag injection fallback.

### 3.3 `background.service_worker` → `background.scripts`
Firefox is more compatible with an event-page `background.scripts`. **Decision:** swap to `scripts`. The worker itself (a `commands.onCommand` listener) is trivial and portable.

### 3.4 API namespace + manifest additions
- Adopt `webextension-polyfill` so `chrome.*` → `browser.*` promise API works uniformly on both browsers.
- Add `browser_specific_settings.gecko.id` (e.g. `appsheet-assistant@<domain>`) and a minimum-version pin (`128.0`).

### 3.5 CORS for AI `fetch()`
Provider calls run from an extension context covered by `host_permissions` (background or isolated content world — **not** the MAIN world, which is page-privileged and subject to page CORS). Firefox honors host-permission CORS bypass there. **Decision:** ensure all provider `fetch()` originates from the isolated/background context.

---

## 4. Build tooling & repo structure

**Toolchain:** Vite + `vite-plugin-web-extension` (better Firefox/`web-ext` integration than `@crxjs`), TypeScript, `webextension-polyfill`, `web-ext` (Mozilla CLI for run/lint/sign/package).

**One codebase, two targets:** generate the manifest from `src/manifest.ts` with a `--target=firefox|chrome` flag. Same source → two zips. Keeps Chrome support for free.

```
appsheet-assistant/
├── src/
│   ├── background/index.ts        # was bg.js
│   ├── content/
│   │   ├── index.ts               # isolated-world entry (loader + main bundle, merged, single file)
│   │   └── bridge.ts              # MAIN-world script (was main-world.ts)
│   ├── popup/                     # React UI
│   │   ├── index.html
│   │   └── ...
│   ├── lib/                       # AI providers, schema logic, storage, backup — reversed & cleaned
│   └── manifest.ts                # per-target manifest generation
├── docs/
├── LICENSE                        # MIT
├── package.json
└── vite.config.ts
```

---

## 5. Reverse-engineering workflow

Reverse **behavior**, not vendor code.

1. **Beautify** all three bundles (`prettier` / `js-beautify`).
2. **Split vendor from app code.** Identify React/ReactDOM/UI libs and `npm install` the real packages — do not reverse them (deletes ~70% of the reading).
3. **Extract app modules** into clean typed `src/lib/`: AI provider adapters, schema-check rules, backup format, Ctrl+K palette, dark-mode toggle.
4. **Bridge** is already decompiled and readable — just retype it.

### What actually gets reversed (the ~30% that matters)
- Message protocol (`__hoc_appsheet_request/response`, `__hoc: toggle-panel`)
- AI provider request/response shapes (v1: Gemini + DeepSeek only — see §6)
- Schema-validation rules
- Backup format
- `setFormatColumns` (SFC) React-manipulation routine (the fiddly part)

### Data flow (must survive the port)
```
Popup (React) ──browser.runtime──► Background ──tabs.sendMessage──► Content (isolated world)
                                                                          │ window.postMessage
                                                                          ▼
                                                      Bridge (MAIN world) ──► window.currentApp() / React internals
                                                                          │
AI providers ◄──── fetch() from isolated/background context (host_permissions) ──────┘
```

### Error handling / safety contract (port exactly)
- Context-invalidation guard (from §3.1).
- **No auto-save + backup-before-write** — non-negotiable safety contract.
- `chrome.runtime.lastError` swallowing → clean `browser.*` promise `.catch()`.

---

## 6. Scope: providers

**v1 ships with 2 providers, iterate to add the rest:**
- **Google Gemini** (`generativelanguage.googleapis.com`)
- **DeepSeek** (`api.deepseek.com`) — cheapest option benchmarked (DeepSeek V4 Flash ≈ $0.14/$0.28 per 1M tokens in/out, 2026), and already in the original's `host_permissions`.

Both are already covered by existing host permissions → **no manifest permission changes for v1**. OpenAI, Moonshot, and DashScope are added incrementally in later releases (full parity is the eventual goal).

---

## 7. Licensing, attribution & distribution

**Licensing:** The original ships no license (default "all rights reserved"), so we do not redistribute its code. Because we rebuild clean modules from reversed *behavior*, the resulting code is original expression → licensable as **MIT**.

**Attribution:**
- Credit Hoadata prominently in the README and the extension's About screen ("Originally a port of *Assistant for AppSheet* by Hoadata — [link]").
- Do **not** reuse the original's name, icons, or store copy — those are separately protected. New name + new icons required.

**Distribution (AMO):**
- Package/sign with `web-ext sign`.
- Requires `browser_specific_settings.gecko.id`.
- Submit source (build is minified) — fine, it's open source.

---

## 8. Testing

- **`web-ext run`** — live dev against a real AppSheet editor tab (the DOM/`currentApp()` path can't be unit-tested).
- **Vitest** — unit tests for pure logic: provider adapters, schema validation, backup format.
- **Manual smoke checklist** — the React-manipulation path (SFC) against a live AppSheet editor.

---

## 9. Open items for implementation

- Pick the new extension name + icons.
- Choose the `gecko.id` value.
- Confirm exact Gemini + DeepSeek request/response shapes during reversing.

---

## 10. Future / out of scope for v1

### 10.1 Local-model endpoint (near-free, likely a fast follow)
Since the extension already speaks the OpenAI wire format, adding a provider whose **base URL is configurable** lets users point at a local server (Ollama / LM Studio / Jan, OpenAI-compatible at e.g. `http://localhost:11434/v1`). This gives free, per-call-zero-cost inference with local models — no API key, no quota. Cheap to add (it's BYOK with a custom base URL). Not v1, but a strong candidate for v1.x.

### 10.2 MCP bridge (v2 — separate, larger product)
Goal: let users drive AppSheet with their **Claude / Antigravity subscription** instead of a per-token API key.

**Why it can't be a simple endpoint swap:** Claude Desktop and Antigravity are MCP *clients* — they do not expose an inbound local completion API to POST prompts to. The only spec mechanism (MCP *sampling*, where a server asks the client to run a completion) requires inverting the architecture so the extension is an MCP *server* the desktop app connects to, and client sampling support is currently unreliable. So subscription quota is only reachable by flipping the architecture, not by pointing the existing API call at a desktop app.

**Architecture if pursued:**
```
Claude Desktop / Antigravity (subscription) ──MCP──► local MCP server (Node) ──Native Messaging──► extension ──► AppSheet
```
The extension becomes pure "hands"; the frontier model is the "brain." Requires a **native messaging host** (a small local Node process that is the MCP server and bridges to the extension). Trade-offs vs BYOK: subscription cost model + no keys in browser + more powerful multi-step reasoning, but heavier install, narrower audience (MCP-client users only), and loss of the in-editor popup UX.

**Why v1 sets this up for free:** the `src/lib/` tool functions (`get_schema`, `create_column`, `set_format_columns`, `validate_schema`, `backup_config`) are the exact tools an MCP server would expose. Building them cleanly for v1 makes v2 mostly a wrapping exercise.
```
