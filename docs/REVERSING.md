# Reverse-engineering reference

This document records the behavior contract we are preserving from the
original *Assistant for AppSheet — by Hoadata* Chrome extension while
rebuilding it as an independent, cross-browser project. It is derived from
static analysis of the original's decompiled/minified production bundles,
beautified for readability into the gitignored `reverse/` directory (not
committed — see `.gitignore`). Every claim below cites a line (or line
range) in the beautified file it was verified against, so the anchors can be
re-checked by opening `reverse/*.pretty.js` / `reverse/bridge.original.js`
directly.

Source bundles (from the decompiled Chrome build, one directory up from this
repo, `../assets/`):

| Original file | Beautified copy | Role |
|---|---|---|
| `content.ts-Dr0xu8FA.js` (276 KB) | `reverse/content.pretty.js` (10,739 lines) | ISOLATED-world content script: React UI (side panel, tabs, command palette), changeset generation/validation/execution, storage, backups. Dynamically `import()`-ed by `assets/content.ts-loader-GyPbXmyS.js` (not itself part of the three bundles beautified here) and exports `onExecute`. |
| `index-CM1hudoN.js` (164 KB) | `reverse/index.pretty.js` (9,921 lines) | React production build + settings store + all AI provider adapters (Gemini/Claude/OpenAI/DeepSeek/Qwen/Moonshot). |
| `main-world.ts-tWt02csn.js` (2.7 KB) | `reverse/bridge.original.js` (verbatim copy, 2 lines, minified) and `reverse/bridge.pretty.js` (155 lines, beautified for line-anchoring) | MAIN-world bridge: reads `window.currentApp()` and drives the AppSheet editor's React "Format these columns and actions" `<select>`. |

`reverse/bridge.original.js` is a byte-for-byte `cp` of the original file (per
task brief Step 1); `reverse/bridge.pretty.js` is an additional
prettier-formatted copy of the *same* source, produced only so this document
can cite specific line numbers — it is not a separate source of truth.

Manifest/architecture context (from `manifest.json` and `assets/bg.js` in the
decompiled build, not part of the three beautified bundles but useful
background):
- `content_scripts` match `https://www.appsheet.com/template/*` and
  `.../Template/*`, `run_at: "document_idle"`. Two content scripts are
  registered: the ISOLATED-world loader (`content.ts-loader-*.js`) and the
  MAIN-world bridge (`world: "MAIN"`).
- `commands.toggle-panel` has `suggested_key.default: "Alt+A"`.
- `background.service_worker` (`assets/bg.js`) listens for
  `chrome.commands.onCommand("toggle-panel")` and relays it to the active
  tab via `chrome.tabs.sendMessage(tabId, { __hoc: "toggle-panel" })`.
- `host_permissions` includes `api.openai.com`, `api.anthropic.com`,
  `generativelanguage.googleapis.com`, `api.deepseek.com`,
  `api.moonshot.ai`, `dashscope-intl.aliyuncs.com` — one per provider.
- `permissions`: `["storage"]` only.

---

## 1. Bridge protocol (MAIN world ↔ ISOLATED world)

Canonical/verbatim source: `reverse/bridge.original.js` (2 lines, minified).
Line numbers below are into the beautified `reverse/bridge.pretty.js`, which
is the same code reformatted.

- **Request tag**: `"__hoc_appsheet_request"` — `reverse/bridge.pretty.js:2`
  (`const a = "__hoc_appsheet_request"`).
- **Response tag**: `"__hoc_appsheet_response"` — `reverse/bridge.pretty.js:3`
  (`u = "__hoc_appsheet_response"`).
- **Transport**: `window.postMessage` both ways. The bridge listens with
  `window.addEventListener("message", ...)` at `reverse/bridge.pretty.js:137-153`,
  checks `t.source === window` and `e.__tag === a` (the request tag) before
  acting (line 138, 140), then replies with
  `{ __tag: u, id, result }` or `{ __tag: u, id, error }` via
  `window.postMessage(n, "*")` (lines 144-152).
- **Action router** `p(t, pl)` — `reverse/bridge.pretty.js:110-136`:
  - `"ping"` → `{ ok: true, hasCurrentApp: typeof window.currentApp == "function" }` (lines 112-116).
  - `"getAppTemplate"` → `currentApp()?.appTemplate ?? null` (lines 117-120).
  - `"getAppId"` → `currentApp()?.appId ?? currentApp()?.id ?? null` (lines 121-126).
  - `"getAppName"` → `currentApp()?.appName ?? null` (lines 127-130).
  - `"setFormatColumns"` → delegates to `SFC(pl)` (lines 131-132).
  - default → `throw new Error("Unknown bridge action: " + t)` (lines 133-134).
- **`currentApp()` wrapper** `o()` — `reverse/bridge.pretty.js:4-12`: calls
  `window.currentApp()` (a global provided by AppSheet's own editor page, not
  by the extension) inside a try/catch, returns `null` on any throw or if
  `window.currentApp` isn't a function.
  - **Shape consumed**: `{ appTemplate, appId (or id), appName }` — confirmed
    by the three field accesses above (lines 119, 124, 129). `appId` is
    preferred over the fallback `id` (`??` chain, line 124).
- **`setFormatColumns` / `SFC(pl)`** — `reverse/bridge.pretty.js:13-109`:
  1. Input values: `(pl && pl.values) || pl || []` (line 15).
  2. Select element lookup (line 16-20), selector string:
     `'.FormControl[data-label="Format these columns and actions"] select, .MultiselectControl select, select[multiple]'`
     — prefers the first visible candidate (`offsetParent !== null`, line 22-24),
     falls back to the first match in DOM order.
  3. If no select found: returns `{ ok: false, reason: "no select", cands: cands.length }` (line 25).
  4. Value normalization `nrm()` (lines 26-32): lowercases, trims, strips a
     leading `__action__` prefix and a trailing `" action"`/`"actions"` suffix
     (regex `/^__action__/` and `/s*(action)s*$/` — note: the second regex's
     `s*` is a **literal `s*`**, not `\s*`, in the original minified source;
     preserved as-is here since it is what production actually runs).
  5. Marks matching `<option>`s `selected = true` by comparing normalized
     `value` or `textContent` against the normalized wanted list (lines 35-41).
  6. React wiring: looks for an own-property key starting with
     `"__reactProps$"` on the select element (lines 42-47); if not found or
     its `onChange` isn't a function, walks up to **6** fiber nodes via a key
     starting with `"__reactFiber$"` (`for (var i = 0; i < 6 && f; i++)`,
     lines 48-65), checking `f.memoizedProps.onChange` at each level and
     climbing via `f = f.return`.
  7. Builds a synthetic React-SyntheticEvent-shaped object `mkev(type)`
     (lines 66-83: `target`, `currentTarget`, `type`, `bubbles: true`, no-op
     `preventDefault`/`stopPropagation`/`persist`, `isDefaultPrevented`/
     `isPropagationStopped` returning `false`, `nativeEvent: { target: sel }`).
  8. Fires `props.onChange(mkev("change"))` if a React `onChange` handler was
     found (line 84-88); otherwise dispatches a native
     `new Event("change", { bubbles: true })` (line 90).
  9. Then fires `props.onBlur(mkev("blur"))` if present (lines 92-96) **and
     regardless** dispatches a native `new Event("blur", { bubbles: true })`
     (lines 97-99) — i.e. blur always fires natively in addition to any React
     handler.
  10. Returns `{ ok: any, selected: [...selectedOptions values] }`, or
      `{ ok: false, reason: String(e.message || e) }` on exception (lines 100-108).

The ISOLATED-world caller side of this protocol lives in
`reverse/content.pretty.js`:
- The same two tag strings are redeclared locally as `ge`/`be` at
  `reverse/content.pretty.js:444-445`.
- `afBridge(action, timeout, payload)` — `reverse/content.pretty.js:8840-8860` —
  generates a random `id`, listens for the matching
  `"__hoc_appsheet_response"` message, `postMessage`s the
  `"__hoc_appsheet_request"`, and rejects with `"bridge timeout"` after
  `timeout || 4000` ms.
- Call sites: `afBridge("getAppTemplate", 6000)` (exposed as
  `getTemplate` on `window.__hocAutoFillApi`, `reverse/content.pretty.js:10555`)
  and `afBridge("setFormatColumns", 6000, { values })`
  (`reverse/content.pretty.js:10308`).

## 2. Command message: background → content

- Background (`assets/bg.js`, original — not one of the three beautified
  bundles, only 10 lines, quoted in full for reference):
  ```js
  chrome.commands.onCommand.addListener((cmd) => {
    if (cmd !== "toggle-panel") return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const t = tabs && tabs[0];
      if (!t || t.id == null) return;
      chrome.tabs.sendMessage(t.id, { __hoc: "toggle-panel" }, () => { void chrome.runtime.lastError; });
    });
  });
  ```
- Content-script receiver — `reverse/content.pretty.js:7794-7806`:
  ```
  d.useEffect(() => {
    const fn = (msg) => { if (msg && msg.__hoc === "toggle-panel") a((v2) => !v2); };
    chrome.runtime.onMessage.addListener(fn);
    return () => chrome.runtime.onMessage.removeListener(fn);
  }, []);
  ```
  `a` is the panel-open `useState` setter — the message toggles panel
  visibility. Manifest binds this to keyboard shortcut `Alt+A`
  (`commands.toggle-panel.suggested_key.default`, `manifest.json`).

## 3. Provider call shapes

Registry — `reverse/index.pretty.js:9896-9907`:
```js
const qd = { gemini: Bd, claude: hocClaude, openai: Kd, deepseek: Gd, qwen: Xd, moonshot: Jd },
  np = ["gemini", "deepseek", "claude", "qwen", "moonshot", "openai"];
function rp(e) { return qd[e]; }
```
Six providers exist in the original; **v1 of this rebuild only implements
Gemini and DeepSeek** (see `README.md` "Providers (v1)") — the rest of this
section is documented for completeness/future extension, not as a v1
requirement.

- **Gemini** — `reverse/index.pretty.js:9526-9591`:
  - Request built at lines 9530-9544: `contents` mapped from non-system
    messages (`role: assistant → "model"`, else `"user"`; `parts: [{text}]`),
    `generationConfig.temperature` (default `0.3`), `maxOutputTokens` (default
    `4096`), and `responseMimeType: "application/json"` when `jsonMode` is
    set (line 9541). A system message, if present, becomes
    `systemInstruction.parts[0].text` (line 9544).
  - URL (line 9545):
    `` `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}` ``
    — `POST`, `Content-Type: application/json` (lines 9546-9551).
  - Response parsed from `candidates[0].content.parts[].text` joined, plus
    `usageMetadata.promptTokenCount` / `candidatesTokenCount` (lines 9558-9574).
  - Key validation `Hd()` (lines 9576-9591): `GET
    https://generativelanguage.googleapis.com/v1beta/models?key=...&pageSize=1`;
    `ok` response ⇒ valid (returns `null`); otherwise returns the API's error
    message or a generic "Validation failed" string.
- **Generic OpenAI-compatible adapter factory** `gl(e)` —
  `reverse/index.pretty.js:9593-9655` — parameterized by `{ config, baseUrl,
  extraHeaders, validateEndpoint }`:
  - Chat (`o(u, s)`, lines 9596-9634): request body
    `{ model, messages, temperature: 0.3 default, max_tokens: 4096 default }`,
    `response_format: { type: "json_object" }` when `jsonMode` (line 9604).
    `POST {baseUrl}/chat/completions` with `Authorization: Bearer {apiKey}`
    plus any `extraHeaders(apiKey)` (lines 9605-9614). Response parsed from
    `choices[0].message.content`, usage from `usage.prompt_tokens` /
    `usage.completion_tokens` (lines 9621-9633).
  - Key validation (`i(u)`, lines 9635-9653): `GET {baseUrl}{validateEndpoint
    ?? "/models"}` with the bearer token; `ok` ⇒ valid.
  - Instantiations (all reuse the same `/chat/completions` shape):
    - OpenAI: `Kd = gl({ config: Wd, baseUrl: "https://api.openai.com/v1" })` — line 9690.
    - **DeepSeek**: `Gd = gl({ config: Qd, baseUrl: "https://api.deepseek.com/v1" })` — line 9723.
    - Qwen (DashScope): `Xd = gl({ config: Yd, baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" })` — lines 9747-9750.
    - Moonshot (Kimi): `Jd = gl({ config: Zd, baseUrl: "https://api.moonshot.ai/v1" })` — line 9781.
- **Claude (Anthropic)** — does **not** go through the `gl()` factory (its
  request/response shape differs); implemented directly in
  `hocClaudeChat`/`hocClaudeValidate`, `reverse/index.pretty.js:9820-9895`:
  - `POST https://api.anthropic.com/v1/messages` with headers
    `x-api-key`, `anthropic-version: "2023-06-01"`,
    `anthropic-dangerous-direct-browser-access: "true"` (lines 9841-9848) —
    the last header is required because these calls are made directly from
    the browser (no proxy backend).
  - Body: `{ model, max_tokens, messages, temperature, system? }`; a
    `jsonMode` flag appends a "Return ONLY a single valid JSON object..."
    instruction to the system prompt instead of using a response-format
    field (lines 9829-9833).
  - Response parsed from `content[].filter(type==="text").text` joined,
    usage from `usage.input_tokens`/`output_tokens` (lines 9858-9868).
  - Key validation: `GET https://api.anthropic.com/v1/models?limit=1` with
    the same headers (lines 9871-9890).

## 4. Storage

Original extension declares only `"permissions": ["storage"]` (both
`chrome.storage.local` and `.sync` come from that single permission).
**v1 of this rebuild uses `storage.local` only** (per task scope) — the
`sync` usage below is documented so a future task can decide whether to add
it back.

| Key (or key template) | Store(s) | Purpose | Anchor |
|---|---|---|---|
| `hoc_appsheet_settings_v1` | `local` (primary write+read); `sync` (read fallback if `local` is empty; write-mirrored **excluding** `apiKeys`) | Settings object: `{ activeProvider, activeModel, apiKeys, language, inlineButtonsEnabled, version }` | Default shape + key name: `reverse/index.pretty.js:9369-9377`. Read (`rc()`, local-then-sync-fallback): `9395-9419`. Write (`Fd()`, local always + sync mirror with `apiKeys: {}` stripped): `9420-9433`. |
| `hoc_theme` | `local` (primary) + `sync` (fallback read / mirrored write, full value incl.) | `"dark"` \| `"light"` UI theme | Read: `reverse/content.pretty.js:7759-7768`. Write (`toggleTheme`): `7834-7847`. |
| `hoc_history_${feature}_v1` (per-feature key, e.g. per tab) | `local` only | Last 20 (`Ce = 20`) generation/prompt history entries, each `{ ...entry, id: crypto.randomUUID(), timestamp }` | Key + cap: `reverse/content.pretty.js:1077-1078`. Read `K()`: `1079-1081`. Append `D()`: `1082-1087`. Delete-one `Te()`: `1088-1091`. Clear `$e()`: `1092-1094`. |
| `hoc_schema_cache_${appId}_v1` | `local` only | Cached app schema `{ schema, storedAt, fingerprint }`, TTL `ve = 24h` (`24*60*60*1000` ms) | Key + TTL const: `reverse/content.pretty.js:484-485`. Write `G()`: `698-707`. Read `je()` (TTL check `Date.now() - storedAt > ve`): `709-717`. |
| `hoc_app_backups` | `local` only | Array of up to 5 backup entries `{ ts, href, app: appTemplate }`, newest first | Push (`hocPushBackup`, halves the array and retries on `chrome.runtime.lastError`/quota errors): `reverse/content.pretty.js:7514-7532`. Read for "pre-run backup" download: `6805-6817`. Delete-all: `7717`. |
| `hoc_seen_version` | `local` only | Last-seen extension version, drives an "Updated to version X" toast | `reverse/content.pretty.js:7773-7793`. |
| `hoc_privacy_consent` | `local` only | Boolean consent flag | `reverse/content.pretty.js:7807-7821`. |
| `hoc_last_tab` | `local` only | Last-active side-panel tab id, restored on reload | `reverse/content.pretty.js:7822-7833`. |
| `hoc_ctx_full` | `local` only | Toggle for "full" vs. trimmed app-context size sent to the AI | Read: `reverse/content.pretty.js:4950`. Write: `6067`. |
| usage log (`hocUsageKey`) | `local` only | Per-something usage/rate log array | `reverse/content.pretty.js:290-297`. |

Note the settings sync behavior is asymmetric by design: reads fall back to
`sync` only when `local` is empty (line 9401), but writes always go to
`local` and *additionally* mirror to `sync` with API keys stripped out
(`{ ...e, apiKeys: {} }`, line 9426) — i.e. the original never syncs API
keys across devices, only non-secret settings.

## 5. Feature list to preserve

- **Generate columns / views / actions / format rules.** The AI is driven by
  a changeset-generation system prompt, `hocChangesetPrompt()` —
  `reverse/content.pretty.js:4870-4939`. The changeset `op` vocabulary (line
  4879): `set_column | add_view | set_view | add_action | set_action |
  add_format_rule | set_format_rule` (virtual columns are explicitly
  disallowed — line 4922). Per-op required/optional fields and constraints
  are enumerated at lines 4921-4934 (e.g. `add_view` requires
  `table`+`name`+`viewType`; `add_action` requires
  `table`+`name`+`actionType`; `REF_ACTION` requires `referencedTable`+
  `referencedAction`; `COMPOSITE` requires an `actions` array of
  already-created action names). Execution/apply flow is
  `hocRunChanges(list, setFill)` — `reverse/content.pretty.js:5086-5130+` —
  which drives `window.__hocAutoFillApi.fillAll(list, progressCb)` with
  per-item `pending → running → done` status, and for format rules
  specifically walks the editor UI via `afGotoFormatRules`/`afOpenFormatRule`/
  `afFillFormatRule` (`reverse/content.pretty.js:10263-10401+`).
- **Schema validation (+ did-you-mean suggestions).** `afValidate(appTemplate,
  changeset)` — `reverse/content.pretty.js:8921-9081+` — builds a
  table→columns map from the app template (`afBuildMap`,
  `reverse/content.pretty.js:8862-8879`), then for each change verifies
  required fields are present, that `table`/`view`/`action`/`rule`
  references exist, and that enum-like fields (`viewType`, `position`) are
  valid, e.g. table-not-found at lines 8957-8964. Typo suggestions use a
  Levenshtein distance (`afLev`, `reverse/content.pretty.js:8880-8902`) via
  `afNearest`/`afSug` (lines 8903-8920) — accepted only if the edit distance
  is within `max(2, floor(len*0.4))` (line 8915).
- **Backup-before-write.** Before executing any changeset, the current app
  template is fetched and pushed into the `hoc_app_backups` local-storage
  ring buffer via `hocPushBackup(tpl)` — call site
  `reverse/content.pretty.js:5808-5811` (function `C`, which precedes the
  `hocRunChanges` call at 5770-5771), buffer implementation
  `reverse/content.pretty.js:7514-7532` (keeps the 5 most recent entries).
  There's also an explicit manual "Backup app (.json)" download action
  (`doBackup`, `reverse/content.pretty.js:5776-5790`) independent of the
  automatic pre-write snapshot.
- **Dark mode.** Persisted per `hoc_theme` (§4 above); applied by adding a
  `"hoc-dark"` class (`reverse/content.pretty.js:7973`,
  `className: dark ? "hoc-dark" : ""`) which a block of `!important`
  CSS-variable-free overrides (`HOC_DARK_CSS`,
  `reverse/content.pretty.js:5142-5173`) targets alongside the Tailwind
  utility classes already present in the DOM (e.g. `.hoc-dark .bg-white`,
  `.hoc-dark .text-slate-700`, …) — i.e. dark mode is a CSS-class override
  layer on top of Tailwind, not a separate stylesheet or `prefers-color-scheme`
  media query.
- **Ctrl+K command palette.** Global `keydown` listener (capture phase,
  `addEventListener(..., true)`) —
  `reverse/content.pretty.js:7848-7861` — triggers on
  `(ev.ctrlKey || ev.metaKey) && (ev.key === "k" || ev.key === "K")`
  (so both Ctrl+K on Windows/Linux and Cmd+K on macOS are recognized),
  `preventDefault`/`stopPropagation`s the browser's own shortcut, opens the
  panel and toggles the palette. The command list (`cmds`,
  `reverse/content.pretty.js:7862`+) includes tab-switch commands
  (`assistant`/`generator`/`explainer`/`fixer`/`ask`) and a "Backup app
  (.json)" command (line 7919-7921).

---

## Anchors verified

Every line/line-range citation above was checked directly against the
beautified files in this pass (not copied from the task brief without
re-verification):

- `reverse/bridge.pretty.js` (155 lines) — read in full; all bridge-protocol
  citations (§1) point at exact lines in that reading.
- `reverse/content.pretty.js` (10,739 lines) — targeted reads around each
  cited region: 290-297, 444-445, 484-485, 690-717, 1060-1094, 4727 area,
  4860-4939, 4950, 5086-5130, 5142-5173, 5770-5815, 6067, 6805-6820,
  7514-7973, 8820-8920, 8921-9010, 10263-10401, 10530-10560.
- `reverse/index.pretty.js` (9,921 lines) — targeted reads around
  9340-9440, 9526-9655, 9656-9910.
- `manifest.json`, `assets/bg.js`, `assets/content.ts-loader-GyPbXmyS.js` in
  the decompiled build (outside the three beautified bundles) — read in
  full for the architecture-context section only; no line-anchor claims
  into `reverse/*.pretty.js` are made from these three files.

One inaccuracy in the task-brief anchors was corrected here: the "wraps up
to 6 fibers" detail is real (`reverse/bridge.pretty.js:54`, `for (var i = 0;
i < 6 && f; i++)`), but the fiber-walk only runs as a *fallback* when a
`__reactProps$`-keyed prop with a function `onChange` isn't found directly
on the element (line 48's `if (!props || typeof props.onChange !== "function")`)
— it is not the primary path.
