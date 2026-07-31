# AppSheet Assistant — Firefox Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Chrome "Assistant for AppSheet" extension as a clean, open-source, cross-browser (Firefox 128+ / Chrome) extension with v1 providers Gemini + DeepSeek.

**Architecture:** One TypeScript codebase, Vite-built, emitting per-target manifests. Isolated-world content script (single bundle, no dynamic import) mounts the React UI and relays to a `world:"MAIN"` bridge that touches AppSheet's `window.currentApp()` and React internals. AI providers are called via `fetch()` from the isolated/background context (host-permission CORS). Pure logic (providers, schema-check, backup, storage) lives in `src/lib/` as unit-tested modules; the DOM/React path is smoke-tested manually.

**Tech Stack:** TypeScript, Vite + `vite-plugin-web-extension`, React, `webextension-polyfill`, Vitest, `web-ext`.

## Global Constraints

- Target Firefox **128.0+** (native `world:"MAIN"`) and Chrome. Both from one source via a `--target` build flag.
- Content layer ships as a **single bundled file** — no dynamic `import()`. Keep the `chrome.runtime.id` context-invalidation guard.
- Background is `background.scripts` (event page), **not** `service_worker`.
- All extension API access goes through `webextension-polyfill` as `browser.*` (promises).
- Provider `fetch()` runs from isolated/background context only — never MAIN world.
- **Safety contract (non-negotiable):** never auto-save; every AppSheet write is user-confirmed and preceded by a config backup.
- License **MIT**. Credit Hoadata in README + About screen. Do **not** reuse the original name, icons, or store copy.
- v1 providers: **Gemini** (`:generateContent`) and **DeepSeek** (OpenAI-style `chat/completions`). Provider base URL is user-configurable (enables local Ollama/LM Studio later at zero extra cost).

---

## File Structure

```
appsheet-assistant/
├── src/
│   ├── manifest.ts                 # buildManifest(target) → per-browser manifest
│   ├── background/index.ts         # commands listener (toggle-panel)
│   ├── content/
│   │   ├── index.ts                # isolated-world entry: context guard, mount panel, bridge client, toggle receiver
│   │   ├── bridge.ts               # MAIN-world: ping/getApp*/setFormatColumns
│   │   └── panel.tsx               # in-editor panel + Ctrl+K palette (React)
│   ├── popup/
│   │   ├── index.html
│   │   └── App.tsx                 # settings: provider, API key, base URL, dark mode
│   └── lib/
│       ├── messaging.ts            # bridge protocol types + sendToBridge()
│       ├── appsheet.ts             # getSchema() via bridge
│       ├── storage.ts              # settings/backups via browser.storage.local
│       ├── schema-check.ts         # validateSchema()
│       ├── backup.ts               # makeBackup() / backup format
│       └── providers/
│           ├── types.ts            # AiProvider interface, CompletionRequest/Result
│           ├── gemini.ts
│           ├── deepseek.ts
│           └── index.ts            # registry
├── tests/                          # Vitest unit tests (mirrors src/lib)
├── reverse/                        # beautified original bundles (gitignored, reference only)
├── docs/
├── LICENSE
├── README.md
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## Task 1: Project bootstrap + cross-target manifest

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`, `LICENSE`, `README.md`
- Create: `src/manifest.ts`
- Test: `tests/manifest.test.ts`

**Interfaces:**
- Produces: `buildManifest(target: "firefox" | "chrome"): object`

- [ ] **Step 1: Init repo + install deps**

```bash
git init
npm init -y
npm i react react-dom webextension-polyfill
npm i -D typescript vite vite-plugin-web-extension @types/react @types/react-dom @types/webextension-polyfill vitest web-ext
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/manifest.test.ts
import { describe, it, expect } from "vitest";
import { buildManifest } from "../src/manifest";

describe("buildManifest", () => {
  it("firefox target uses background.scripts and gecko id", () => {
    const m = buildManifest("firefox") as any;
    expect(m.background.scripts).toEqual(["src/background/index.ts"]);
    expect(m.background.service_worker).toBeUndefined();
    expect(m.browser_specific_settings.gecko.id).toMatch(/@/);
    expect(m.browser_specific_settings.gecko.strict_min_version).toBe("128.0");
  });
  it("chrome target uses service_worker, no gecko settings", () => {
    const m = buildManifest("chrome") as any;
    expect(m.background.service_worker).toBe("src/background/index.ts");
    expect(m.background.scripts).toBeUndefined();
    expect(m.browser_specific_settings).toBeUndefined();
  });
  it("both declare the MAIN-world content script and host permissions for v1 providers", () => {
    for (const t of ["firefox", "chrome"] as const) {
      const m = buildManifest(t) as any;
      const worlds = m.content_scripts.map((c: any) => c.world);
      expect(worlds).toContain("MAIN");
      expect(m.host_permissions).toEqual(
        expect.arrayContaining([
          "https://www.appsheet.com/*",
          "https://generativelanguage.googleapis.com/*",
          "https://api.deepseek.com/*",
        ]),
      );
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/manifest.test.ts`
Expected: FAIL — cannot find module `../src/manifest`.

- [ ] **Step 4: Implement `src/manifest.ts`**

```ts
// src/manifest.ts
type Target = "firefox" | "chrome";

export function buildManifest(target: Target) {
  const base: any = {
    manifest_version: 3,
    name: "AppSheet Assistant", // NOTE: final name TBD — must differ from original
    version: "1.0.0",
    description: "AI assistant for the AppSheet editor: build columns/views/actions, check schema, back up config.",
    icons: { "48": "icons/icon48.png", "128": "icons/icon128.png" },
    action: { default_popup: "src/popup/index.html" },
    options_ui: { page: "src/popup/index.html", open_in_tab: true },
    permissions: ["storage"],
    host_permissions: [
      "https://www.appsheet.com/*",
      "https://generativelanguage.googleapis.com/*",
      "https://api.deepseek.com/*",
    ],
    commands: {
      "toggle-panel": {
        suggested_key: { default: "Alt+A" },
        description: "Toggle the AppSheet Assistant panel",
      },
    },
    content_scripts: [
      {
        matches: ["https://www.appsheet.com/template/*", "https://www.appsheet.com/Template/*"],
        js: ["src/content/index.ts"],
        run_at: "document_idle",
      },
      {
        matches: ["https://www.appsheet.com/template/*", "https://www.appsheet.com/Template/*"],
        js: ["src/content/bridge.ts"],
        world: "MAIN",
        run_at: "document_idle",
      },
    ],
    web_accessible_resources: [
      { resources: ["icons/*"], matches: ["https://www.appsheet.com/*"] },
    ],
  };

  if (target === "firefox") {
    base.background = { scripts: ["src/background/index.ts"] };
    base.browser_specific_settings = {
      gecko: { id: "appsheet-assistant@example.com", strict_min_version: "128.0" }, // NOTE: final id TBD
    };
  } else {
    base.background = { service_worker: "src/background/index.ts" };
  }
  return base;
}
```

- [ ] **Step 5: Wire `vite.config.ts` to the manifest + target flag**

```ts
// vite.config.ts
import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";
import { buildManifest } from "./src/manifest";

const target = (process.env.TARGET as "firefox" | "chrome") ?? "firefox";

export default defineConfig({
  plugins: [
    webExtension({
      manifest: () => buildManifest(target),
      browser: target,
      webExtConfig: { startUrl: ["https://www.appsheet.com/"] },
    }),
  ],
});
```

Add to `package.json` scripts:
```json
{
  "scripts": {
    "dev": "TARGET=firefox vite",
    "build:firefox": "TARGET=firefox vite build",
    "build:chrome": "TARGET=chrome vite build",
    "test": "vitest run",
    "lint:ext": "web-ext lint -s dist"
  }
}
```

- [ ] **Step 6: Run tests + commit**

Run: `npx vitest run tests/manifest.test.ts`
Expected: PASS (3 tests).
```bash
git add -A && git commit -m "chore: bootstrap cross-target extension scaffold + manifest builder"
```

---

## Task 2: Reverse-engineering reference (beautify + map)

**Files:**
- Create: `reverse/` (beautified copies, gitignored), `docs/REVERSING.md`
- Modify: `.gitignore` (add `reverse/`, `dist/`, `node_modules/`)

**Interfaces:**
- Produces: `docs/REVERSING.md` — the documented behavior contract later tasks preserve.

- [ ] **Step 1: Beautify the three original bundles into `reverse/`**

```bash
mkdir -p reverse
npx prettier --parser babel "<original>/assets/content.ts-Dr0xu8FA.js" > reverse/content.pretty.js
npx prettier --parser babel "<original>/assets/index-CM1hudoN.js" > reverse/index.pretty.js
cp "<original>/assets/main-world.ts-tWt02csn.js" reverse/bridge.original.js
```
(`<original>` = path to the decompiled Chrome build directory.)

- [ ] **Step 2: Write `docs/REVERSING.md` documenting the preserved contract**

Record, with line anchors into `reverse/*.pretty.js`:
- **Bridge protocol:** request tag `__hoc_appsheet_request`, response tag `__hoc_appsheet_response`, actions `ping | getAppTemplate | getAppId | getAppName | setFormatColumns`. (Verbatim source in `reverse/bridge.original.js`.)
- **currentApp shape:** `{ appId | id, appName, appTemplate }`.
- **Command message:** background → content `{ __hoc: "toggle-panel" }`.
- **Provider call shapes:** Gemini `:generateContent`; DeepSeek OpenAI-style `POST {base}/chat/completions`. (Anchors in `reverse/index.pretty.js`.)
- **Storage:** original uses `chrome.storage.local` (settings/keys/history/backups) + some `chrome.storage.sync`. v1 uses `local` only.
- **Feature list to preserve:** generate columns/views/actions/format rules, schema validation, backup-before-write, dark mode, Ctrl+K palette.

- [ ] **Step 3: Commit**

```bash
git add .gitignore docs/REVERSING.md && git commit -m "docs: reverse-engineering reference and preserved-behavior contract"
```

---

## Task 3: Background worker (toggle-panel)

**Files:**
- Create: `src/background/index.ts`
- Test: `tests/background.test.ts`

**Interfaces:**
- Produces: background listens for command `"toggle-panel"`, sends `{ __hoc: "toggle-panel" }` to the active tab.

- [ ] **Step 1: Write the failing test**

```ts
// tests/background.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMessage = vi.fn().mockResolvedValue(undefined);
const query = vi.fn().mockResolvedValue([{ id: 42 }]);
let onCommand: (cmd: string) => void;

vi.mock("webextension-polyfill", () => ({
  default: {
    commands: { onCommand: { addListener: (fn: any) => (onCommand = fn) } },
    tabs: { query, sendMessage },
  },
}));

describe("background toggle-panel", () => {
  beforeEach(() => vi.clearAllMocks());
  it("relays toggle-panel to the active tab", async () => {
    await import("../src/background/index");
    await onCommand("toggle-panel");
    expect(query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(sendMessage).toHaveBeenCalledWith(42, { __hoc: "toggle-panel" });
  });
  it("ignores unrelated commands", async () => {
    await onCommand("something-else");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/background.test.ts`
Expected: FAIL — cannot find `../src/background/index`.

- [ ] **Step 3: Implement**

```ts
// src/background/index.ts
import browser from "webextension-polyfill";

browser.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "toggle-panel") return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  try {
    await browser.tabs.sendMessage(tab.id, { __hoc: "toggle-panel" });
  } catch {
    /* no content script on this tab — ignore */
  }
});
```

- [ ] **Step 4: Run test + commit**

Run: `npx vitest run tests/background.test.ts` → PASS (2 tests).
```bash
git add src/background tests/background.test.ts && git commit -m "feat: background toggle-panel relay"
```

---

## Task 4: Messaging protocol + MAIN-world bridge

**Files:**
- Create: `src/lib/messaging.ts`, `src/content/bridge.ts`
- Test: `tests/messaging.test.ts`

**Interfaces:**
- Produces: `BridgeAction = "ping" | "getAppTemplate" | "getAppId" | "getAppName" | "setFormatColumns"`; `sendToBridge<T>(action: BridgeAction, payload?: unknown): Promise<T>`; request/response tag constants `REQ_TAG`, `RES_TAG`.
- The bridge (MAIN world) answers those actions using `window.currentApp()`.

- [ ] **Step 1: Write the failing test (messaging round-trip)**

```ts
// tests/messaging.test.ts
import { describe, it, expect, vi } from "vitest";
import { sendToBridge, REQ_TAG, RES_TAG } from "../src/lib/messaging";

describe("sendToBridge", () => {
  it("posts a tagged request and resolves on the matching response", async () => {
    const posts: any[] = [];
    vi.stubGlobal("window", {
      postMessage: (m: any) => {
        posts.push(m);
        // simulate bridge replying
        const handler = (window as any)._listener;
        handler({ source: window, data: { __tag: RES_TAG, id: m.id, result: "pong" } });
      },
      addEventListener: (_: string, fn: any) => ((window as any)._listener = fn),
      removeEventListener: () => {},
    });
    const res = await sendToBridge<string>("ping");
    expect(posts[0].__tag).toBe(REQ_TAG);
    expect(posts[0].action).toBe("ping");
    expect(res).toBe("pong");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/messaging.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/messaging.ts`**

```ts
// src/lib/messaging.ts
export const REQ_TAG = "__hoc_appsheet_request";
export const RES_TAG = "__hoc_appsheet_response";

export type BridgeAction =
  | "ping"
  | "getAppTemplate"
  | "getAppId"
  | "getAppName"
  | "setFormatColumns";

let counter = 0;

export function sendToBridge<T = unknown>(action: BridgeAction, payload?: unknown): Promise<T> {
  const id = `${Date.now()}_${counter++}`;
  return new Promise<T>((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window) return;
      const d: any = e.data;
      if (!d || d.__tag !== RES_TAG || d.id !== id) return;
      window.removeEventListener("message", onMsg);
      if ("error" in d && d.error) reject(new Error(d.error));
      else resolve(d.result as T);
    };
    window.addEventListener("message", onMsg);
    window.postMessage({ __tag: REQ_TAG, id, action, payload }, "*");
  });
}
```

- [ ] **Step 4: Implement `src/content/bridge.ts` (MAIN world)**

Port from `reverse/bridge.original.js` (retyped; `setFormatColumns`/SFC logic copied verbatim from the original — it is our own analysis output). Structure:

```ts
// src/content/bridge.ts  — runs in MAIN world
import { REQ_TAG, RES_TAG, type BridgeAction } from "../lib/messaging";

declare global {
  interface Window { currentApp?: () => any; __hocAppSheetBridge?: boolean; }
}

function app(): any {
  try { return typeof window.currentApp === "function" ? window.currentApp() ?? null : null; }
  catch { return null; }
}

function setFormatColumns(pl: any) {
  /* PORT VERBATIM from reverse/bridge.original.js `SFC`:
     - find select via '.FormControl[data-label="Format these columns and actions"] select,
       .MultiselectControl select, select[multiple]'
     - normalize values, mark options selected
     - locate React onChange via __reactProps$ / __reactFiber$ (walk up to 6 fibers)
     - fire synthetic change + blur, fall back to native events
     - return { ok, selected } */
}

function handle(action: BridgeAction, payload: unknown) {
  switch (action) {
    case "ping": return { ok: true, hasCurrentApp: typeof window.currentApp === "function" };
    case "getAppTemplate": return app()?.appTemplate ?? null;
    case "getAppId": return app()?.appId ?? app()?.id ?? null;
    case "getAppName": return app()?.appName ?? null;
    case "setFormatColumns": return setFormatColumns(payload);
    default: throw new Error(`Unknown bridge action: ${action}`);
  }
}

window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const d: any = e.data;
  if (!d || d.__tag !== REQ_TAG) return;
  let reply: any;
  try { reply = { __tag: RES_TAG, id: d.id, result: handle(d.action, d.payload) }; }
  catch (err) { reply = { __tag: RES_TAG, id: d.id, error: err instanceof Error ? err.message : String(err) }; }
  window.postMessage(reply, "*");
});
window.__hocAppSheetBridge = true;
```

- [ ] **Step 5: Run test + commit**

Run: `npx vitest run tests/messaging.test.ts` → PASS.
```bash
git add src/lib/messaging.ts src/content/bridge.ts tests/messaging.test.ts && git commit -m "feat: bridge protocol + MAIN-world bridge"
```

---

## Task 5: Storage module

**Files:**
- Create: `src/lib/storage.ts`
- Test: `tests/storage.test.ts`

**Interfaces:**
- Produces: `Settings { provider: "gemini"|"deepseek"; apiKeys: Record<string,string>; baseUrls: Record<string,string>; darkMode: boolean }`; `getSettings(): Promise<Settings>` (with defaults), `saveSettings(patch: Partial<Settings>): Promise<void>`, `listBackups(): Promise<Backup[]>`, `saveBackup(b: Backup): Promise<void>`. (`Backup` defined in Task 8.)

- [ ] **Step 1: Write the failing test**

```ts
// tests/storage.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const store: any = {};
vi.mock("webextension-polyfill", () => ({
  default: {
    storage: { local: {
      get: async (k: string) => ({ [k]: store[k] }),
      set: async (o: any) => Object.assign(store, o),
    } },
  },
}));
import { getSettings, saveSettings } from "../src/lib/storage";

describe("storage settings", () => {
  beforeEach(() => { for (const k in store) delete store[k]; });
  it("returns defaults when empty", async () => {
    const s = await getSettings();
    expect(s.provider).toBe("gemini");
    expect(s.darkMode).toBe(false);
    expect(s.apiKeys).toEqual({});
  });
  it("merges a patch on save", async () => {
    await saveSettings({ provider: "deepseek", apiKeys: { deepseek: "sk-x" } });
    const s = await getSettings();
    expect(s.provider).toBe("deepseek");
    expect(s.apiKeys.deepseek).toBe("sk-x");
    expect(s.darkMode).toBe(false); // untouched default preserved
  });
});
```

- [ ] **Step 2: Run to verify fail.** `npx vitest run tests/storage.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/storage.ts
import browser from "webextension-polyfill";
import type { Backup } from "./backup";

export interface Settings {
  provider: "gemini" | "deepseek";
  apiKeys: Record<string, string>;
  baseUrls: Record<string, string>;
  darkMode: boolean;
}

const DEFAULTS: Settings = { provider: "gemini", apiKeys: {}, baseUrls: {}, darkMode: false };
const S_KEY = "settings";
const B_KEY = "backups";

export async function getSettings(): Promise<Settings> {
  const got = (await browser.storage.local.get(S_KEY)) as any;
  return { ...DEFAULTS, ...(got[S_KEY] ?? {}) };
}
export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ [S_KEY]: next });
}
export async function listBackups(): Promise<Backup[]> {
  const got = (await browser.storage.local.get(B_KEY)) as any;
  return got[B_KEY] ?? [];
}
export async function saveBackup(b: Backup): Promise<void> {
  const all = await listBackups();
  await browser.storage.local.set({ [B_KEY]: [b, ...all].slice(0, 20) }); // ponytail: cap at 20 backups
}
```

- [ ] **Step 4: Run + commit.** PASS → `git commit -m "feat: settings + backup storage"`

---

## Task 6: Provider interface + Gemini adapter

**Files:**
- Create: `src/lib/providers/types.ts`, `src/lib/providers/gemini.ts`
- Test: `tests/providers/gemini.test.ts`

**Interfaces:**
- Produces: `interface AiProvider { id: string; label: string; complete(req: CompletionRequest): Promise<string> }`; `CompletionRequest { system: string; prompt: string; apiKey: string; model?: string; baseUrl?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/providers/gemini.test.ts
import { describe, it, expect, vi } from "vitest";
import { gemini } from "../../src/lib/providers/gemini";

describe("gemini adapter", () => {
  it("posts to generateContent and extracts text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "hello" }] } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await gemini.complete({ system: "sys", prompt: "hi", apiKey: "K" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain(":generateContent");
    expect(url).toContain("key=K");
    expect(JSON.parse(init.body).contents[0].parts[0].text).toBe("hi");
    expect(out).toBe("hello");
  });
  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "rate" }));
    await expect(gemini.complete({ system: "s", prompt: "p", apiKey: "K" })).rejects.toThrow(/429/);
  });
});
```

- [ ] **Step 2: Run to verify fail.** FAIL (modules missing).

- [ ] **Step 3: Implement types + gemini**

```ts
// src/lib/providers/types.ts
export interface CompletionRequest {
  system: string; prompt: string; apiKey: string; model?: string; baseUrl?: string;
}
export interface AiProvider {
  id: string; label: string;
  complete(req: CompletionRequest): Promise<string>;
}
```

```ts
// src/lib/providers/gemini.ts
import type { AiProvider } from "./types";

export const gemini: AiProvider = {
  id: "gemini",
  label: "Google Gemini",
  async complete({ system, prompt, apiKey, model, baseUrl }) {
    const base = baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const m = model ?? "gemini-2.5-flash";
    const res = await fetch(`${base}/models/${m}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  },
};
```

- [ ] **Step 4: Run + commit.** PASS (2 tests) → `git commit -m "feat: provider interface + Gemini adapter"`

---

## Task 7: DeepSeek adapter + registry

**Files:**
- Create: `src/lib/providers/deepseek.ts`, `src/lib/providers/index.ts`
- Test: `tests/providers/deepseek.test.ts`

**Interfaces:**
- Consumes: `AiProvider`, `CompletionRequest` (Task 6).
- Produces: `deepseek: AiProvider`; `PROVIDERS: Record<string, AiProvider>`; `getProvider(id: string): AiProvider`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/providers/deepseek.test.ts
import { describe, it, expect, vi } from "vitest";
import { deepseek } from "../../src/lib/providers/deepseek";
import { getProvider } from "../../src/lib/providers";

describe("deepseek adapter", () => {
  it("posts OpenAI-style chat/completions with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await deepseek.complete({ system: "s", prompt: "p", apiKey: "sk-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-1");
    const body = JSON.parse(init.body);
    expect(body.messages[0]).toEqual({ role: "system", content: "s" });
    expect(body.messages[1]).toEqual({ role: "user", content: "p" });
    expect(out).toBe("ok");
  });
  it("registry resolves by id and throws on unknown", () => {
    expect(getProvider("deepseek").id).toBe("deepseek");
    expect(() => getProvider("nope")).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail.** FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/providers/deepseek.ts
import type { AiProvider } from "./types";

export const deepseek: AiProvider = {
  id: "deepseek",
  label: "DeepSeek",
  async complete({ system, prompt, apiKey, model, baseUrl }) {
    const base = baseUrl ?? "https://api.deepseek.com";
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model ?? "deepseek-chat",
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  },
};
```

```ts
// src/lib/providers/index.ts
import type { AiProvider } from "./types";
import { gemini } from "./gemini";
import { deepseek } from "./deepseek";

export const PROVIDERS: Record<string, AiProvider> = { gemini, deepseek };
export function getProvider(id: string): AiProvider {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
```

- [ ] **Step 4: Run + commit.** PASS (2 tests) → `git commit -m "feat: DeepSeek adapter + provider registry"`

> Note: because `baseUrl` is honored, a local Ollama/LM Studio endpoint works today via the DeepSeek (OpenAI-compatible) adapter — this is the §10.1 hook, free.

---

## Task 8: Config backup module

**Files:**
- Create: `src/lib/backup.ts`
- Test: `tests/backup.test.ts`

**Interfaces:**
- Consumes: `AppSchema` (Task 9 — `{ appId, appName, appTemplate }`); forward-declared here.
- Produces: `Backup { id: string; createdAt: number; appId: string | null; appName: string | null; appTemplate: unknown }`; `makeBackup(schema, now: number): Backup`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/backup.test.ts
import { describe, it, expect } from "vitest";
import { makeBackup } from "../src/lib/backup";

describe("makeBackup", () => {
  it("snapshots the schema with a timestamp and id", () => {
    const schema = { appId: "A1", appName: "My App", appTemplate: { tables: ["T"] } };
    const b = makeBackup(schema, 1000);
    expect(b.appId).toBe("A1");
    expect(b.appName).toBe("My App");
    expect(b.appTemplate).toEqual({ tables: ["T"] });
    expect(b.createdAt).toBe(1000);
    expect(b.id).toContain("1000");
  });
});
```

- [ ] **Step 2: Run to verify fail.** FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/backup.ts
import type { AppSchema } from "./appsheet";

export interface Backup {
  id: string;
  createdAt: number;
  appId: string | null;
  appName: string | null;
  appTemplate: unknown;
}

export function makeBackup(schema: AppSchema, now: number): Backup {
  return {
    id: `backup_${now}`,
    createdAt: now,
    appId: schema.appId,
    appName: schema.appName,
    appTemplate: schema.appTemplate,
  };
}
```

- [ ] **Step 4: Run + commit.** PASS → `git commit -m "feat: config backup snapshot"`

---

## Task 9: AppSheet schema access + validation

**Files:**
- Create: `src/lib/appsheet.ts`, `src/lib/schema-check.ts`
- Test: `tests/schema-check.test.ts`

**Interfaces:**
- Consumes: `sendToBridge` (Task 4).
- Produces: `AppSchema { appId: string | null; appName: string | null; appTemplate: any }`; `getSchema(): Promise<AppSchema>`; `Issue { level: "error" | "warn"; message: string }`; `validateSchema(schema: AppSchema): Issue[]`.

- [ ] **Step 1: Write the failing test (pure validation logic)**

```ts
// tests/schema-check.test.ts
import { describe, it, expect } from "vitest";
import { validateSchema } from "../src/lib/schema-check";

describe("validateSchema", () => {
  it("errors when no app is loaded", () => {
    const issues = validateSchema({ appId: null, appName: null, appTemplate: null });
    expect(issues.some((i) => i.level === "error")).toBe(true);
  });
  it("warns on a table with no columns", () => {
    const schema = { appId: "A", appName: "n", appTemplate: { tables: [{ name: "Orders", columns: [] }] } };
    const issues = validateSchema(schema);
    expect(issues).toContainEqual({ level: "warn", message: 'Table "Orders" has no columns' });
  });
  it("returns empty for a healthy schema", () => {
    const schema = { appId: "A", appName: "n", appTemplate: { tables: [{ name: "Orders", columns: [{ name: "Id" }] }] } };
    expect(validateSchema(schema)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify fail.** FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/appsheet.ts
import { sendToBridge } from "./messaging";

export interface AppSchema { appId: string | null; appName: string | null; appTemplate: any; }

export async function getSchema(): Promise<AppSchema> {
  const [appId, appName, appTemplate] = await Promise.all([
    sendToBridge<string | null>("getAppId"),
    sendToBridge<string | null>("getAppName"),
    sendToBridge<any>("getAppTemplate"),
  ]);
  return { appId, appName, appTemplate };
}
```

```ts
// src/lib/schema-check.ts
import type { AppSchema } from "./appsheet";

export interface Issue { level: "error" | "warn"; message: string; }

export function validateSchema(schema: AppSchema): Issue[] {
  const issues: Issue[] = [];
  if (!schema.appId || !schema.appTemplate) {
    issues.push({ level: "error", message: "No AppSheet app detected in this tab" });
    return issues;
  }
  const tables = schema.appTemplate.tables ?? [];
  for (const t of tables) {
    if (!t.columns || t.columns.length === 0) {
      issues.push({ level: "warn", message: `Table "${t.name}" has no columns` });
    }
  }
  return issues;
}
```

- [ ] **Step 4: Run + commit.** PASS (3 tests) → `git commit -m "feat: schema access + validation"`

---

## Task 10: Isolated-world content entry (mount + toggle + guard)

**Files:**
- Create: `src/content/index.ts`, `src/content/panel.tsx`
- Test: manual smoke (see Step 4) — DOM/React mount is not unit-tested.

**Interfaces:**
- Consumes: `browser.runtime.onMessage` (`{ __hoc: "toggle-panel" }`), `getSettings` (Task 5), `getSchema` (Task 9).
- Produces: mounts `<Panel/>` into a shadow-root container on the AppSheet page; toggles visibility on command + `Ctrl/Cmd+K`.

- [ ] **Step 1: Implement the context guard + mount + toggle**

```ts
// src/content/index.ts
import browser from "webextension-polyfill";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { Panel } from "./panel";

if (!globalThis.chrome?.runtime?.id) {
  console.warn("[AppSheet Assistant] Context invalidated — refresh the tab to reload the helper.");
} else {
  const host = document.createElement("div");
  host.id = "appsheet-assistant-root";
  host.style.display = "none";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  createRoot(shadow).render(createElement(Panel));

  const toggle = () => { host.style.display = host.style.display === "none" ? "block" : "none"; };

  browser.runtime.onMessage.addListener((msg: any) => {
    if (msg?.__hoc === "toggle-panel") toggle();
  });
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); toggle(); }
  });
}
```

- [ ] **Step 2: Implement a minimal `panel.tsx` (real generation flow wired in Task 11)**

```tsx
// src/content/panel.tsx
import { useState } from "react";

export function Panel() {
  const [msg] = useState("AppSheet Assistant ready");
  return <div style={{ padding: 12, font: "14px Roboto, sans-serif" }}>{msg}</div>;
}
```

- [ ] **Step 3: Build + load in Firefox**

Run: `npm run dev` (starts `web-ext run` via the plugin, opens Firefox on appsheet.com).
Verify no manifest/console errors on load.

- [ ] **Step 4: Manual smoke checklist**

- Open an AppSheet editor URL (`https://www.appsheet.com/template/...`).
- Press **Alt+A** → panel toggles. Press **Ctrl+K** → panel toggles.
- DevTools console: no "context invalidated" error on fresh load.
- Reload the extension, do NOT refresh the tab → pressing Alt+A logs the guard warning (expected).

- [ ] **Step 5: Commit.** `git commit -m "feat: content mount, toggle, context guard"`

---

## Task 11: Generation flow (prompt → provider → confirm+backup → apply)

**Files:**
- Modify: `src/content/panel.tsx`
- Create: `src/lib/generate.ts`
- Test: `tests/generate.test.ts`

**Interfaces:**
- Consumes: `getSettings` (5), `getProvider` (7), `getSchema`/`AppSchema` (9), `makeBackup` (8), `saveBackup` (5), `sendToBridge("setFormatColumns")` (4).
- Produces: `buildPrompt(schema: AppSchema, userAsk: string): { system: string; prompt: string }`; `runGeneration(userAsk: string, now: number): Promise<string>` (returns the model's suggestion text; does NOT apply — applying is a separate user-confirmed step).

- [ ] **Step 1: Write the failing test**

```ts
// tests/generate.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildPrompt } from "../src/lib/generate";

describe("buildPrompt", () => {
  it("embeds app name and table names into the prompt", () => {
    const schema = { appId: "A", appName: "Sales", appTemplate: { tables: [{ name: "Orders" }, { name: "Customers" }] } };
    const { system, prompt } = buildPrompt(schema, "add a total column");
    expect(system).toMatch(/AppSheet/i);
    expect(prompt).toContain("Sales");
    expect(prompt).toContain("Orders");
    expect(prompt).toContain("Customers");
    expect(prompt).toContain("add a total column");
  });
});
```

- [ ] **Step 2: Run to verify fail.** FAIL.

- [ ] **Step 3: Implement `generate.ts`**

```ts
// src/lib/generate.ts
import { getSettings } from "./storage";
import { getProvider } from "./providers";
import { getSchema, type AppSchema } from "./appsheet";
import { makeBackup } from "./backup";
import { saveBackup } from "./storage";

export function buildPrompt(schema: AppSchema, userAsk: string) {
  const tables = (schema.appTemplate?.tables ?? []).map((t: any) => t.name).join(", ");
  const system =
    "You are an assistant for the AppSheet editor. Given the app's tables and a request, " +
    "propose concrete columns/views/actions/format rules. Be precise and use AppSheet expression syntax.";
  const prompt = `App: ${schema.appName ?? "(unknown)"}\nTables: ${tables}\n\nRequest: ${userAsk}`;
  return { system, prompt };
}

export async function runGeneration(userAsk: string, now: number): Promise<string> {
  const settings = await getSettings();
  const schema = await getSchema();
  await saveBackup(makeBackup(schema, now)); // safety contract: backup before any suggested write
  const { system, prompt } = buildPrompt(schema, userAsk);
  const provider = getProvider(settings.provider);
  const apiKey = settings.apiKeys[settings.provider] ?? "";
  const baseUrl = settings.baseUrls[settings.provider];
  return provider.complete({ system, prompt, apiKey, baseUrl });
}
```

- [ ] **Step 4: Wire the panel** — text input → `runGeneration` → render suggestion → an **Apply** button that calls `sendToBridge("setFormatColumns", …)` only on explicit click (never automatic). Keep the applied action scoped to what the suggestion targets.

```tsx
// src/content/panel.tsx (generation UI)
import { useState } from "react";
import { runGeneration } from "../lib/generate";
import { sendToBridge } from "../lib/messaging";

export function Panel() {
  const [ask, setAsk] = useState("");
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function run() {
    setBusy(true); setErr("");
    try { setOut(await runGeneration(ask, Date.now())); }
    catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ padding: 12, width: 360, font: "14px Roboto, sans-serif" }}>
      <textarea value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Describe what to build…" />
      <button disabled={busy || !ask} onClick={run}>{busy ? "Thinking…" : "Generate"}</button>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      {out && <pre style={{ whiteSpace: "pre-wrap" }}>{out}</pre>}
    </div>
  );
}
```

- [ ] **Step 5: Run unit test + manual smoke.** `npx vitest run tests/generate.test.ts` → PASS. Manual: set a Gemini key in the popup (Task 12), type a request, confirm a suggestion returns and a backup appears in storage.

- [ ] **Step 6: Commit.** `git commit -m "feat: generation flow with backup-before-write"`

---

## Task 12: Popup settings UI (provider, key, base URL, dark mode)

**Files:**
- Create: `src/popup/index.html`, `src/popup/App.tsx`, `src/popup/main.tsx`
- Test: manual (form persistence via storage covered by Task 5 unit tests).

**Interfaces:**
- Consumes: `getSettings`, `saveSettings` (Task 5); `PROVIDERS` (Task 7).

- [ ] **Step 1: `index.html`**

```html
<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><title>AppSheet Assistant</title></head>
<body style="width:360px"><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>
```

- [ ] **Step 2: `main.tsx` + `App.tsx`**

```tsx
// src/popup/main.tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(<App />);
```

```tsx
// src/popup/App.tsx
import { useEffect, useState } from "react";
import { getSettings, saveSettings, type Settings } from "../lib/storage";
import { PROVIDERS } from "../lib/providers";

export function App() {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => { getSettings().then(setS); }, []);
  if (!s) return null;
  const patch = (p: Partial<Settings>) => { const next = { ...s, ...p }; setS(next); saveSettings(p); };

  return (
    <div style={{ padding: 16, font: "14px Roboto, sans-serif" }}>
      <h1 style={{ fontSize: 16 }}>AppSheet Assistant</h1>
      <label>Provider{" "}
        <select value={s.provider} onChange={(e) => patch({ provider: e.target.value as any })}>
          {Object.values(PROVIDERS).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <label>API key{" "}
        <input type="password" value={s.apiKeys[s.provider] ?? ""}
          onChange={(e) => patch({ apiKeys: { ...s.apiKeys, [s.provider]: e.target.value } })} />
      </label>
      <label>Base URL (optional — e.g. local Ollama){" "}
        <input value={s.baseUrls[s.provider] ?? ""}
          onChange={(e) => patch({ baseUrls: { ...s.baseUrls, [s.provider]: e.target.value } })} />
      </label>
      <label><input type="checkbox" checked={s.darkMode}
        onChange={(e) => patch({ darkMode: e.target.checked })} /> Dark mode</label>
      <p style={{ fontSize: 12, opacity: .7 }}>
        Originally a port of “Assistant for AppSheet” by Hoadata.
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Manual smoke.** Open popup, set provider + key, reopen → values persist. Toggle dark mode → persists.

- [ ] **Step 4: Commit.** `git commit -m "feat: popup settings UI"`

---

## Task 13: Package, lint, and release prep

**Files:**
- Modify: `README.md`, `src/manifest.ts` (final name + `gecko.id`)
- Create: `icons/` (new, original artwork — not the original's)

**Interfaces:** none (packaging).

- [ ] **Step 1: Finalize identity.** Pick the final extension name and `gecko.id` (resolve the two `NOTE:` markers in `manifest.ts`). Add new icons at 48/128px.

- [ ] **Step 2: README with attribution + install/dev instructions.** Include: MIT license note, "Originally a port of *Assistant for AppSheet* by Hoadata — <link>", provider setup (Gemini/DeepSeek keys), local-model tip (base URL).

- [ ] **Step 3: Build both targets + lint.**

```bash
npm run build:firefox && npm run lint:ext
npm run build:chrome
```
Expected: `web-ext lint` reports 0 errors.

- [ ] **Step 4: Full manual smoke (release checklist)** on a live AppSheet editor:
  - Panel toggles (Alt+A, Ctrl+K).
  - Generate returns a suggestion (Gemini and DeepSeek, each with a key).
  - A backup is written before generation; visible in `browser.storage.local`.
  - **Apply** only fires on explicit click; nothing auto-saves.
  - Dark mode toggle reflects in the panel.

- [ ] **Step 5: Commit + tag.**

```bash
git add -A && git commit -m "chore: v1 release prep — identity, icons, README, builds"
git tag v1.0.0
```

- [ ] **Step 6 (optional, when ready to distribute):** `web-ext sign` to submit to AMO (requires source upload since the build is minified — fine, it's open source).

---

## Self-Review

**Spec coverage:**
- §2 four parts → Tasks 3 (bg), 4 (bridge), 10 (content), 12 (popup). ✅
- §3.1 no dynamic import / single content bundle → Task 10 (single entry, guard). ✅
- §3.2 world:MAIN 128+ → Task 1 manifest + Task 4 bridge. ✅
- §3.3 background.scripts → Task 1 (target-conditional) + Task 3. ✅
- §3.4 polyfill + gecko.id → Tasks 1, 3, 5, 13. ✅
- §3.5 fetch from isolated/bg context → Tasks 6/7 adapters called via Task 11 (content/isolated). ✅
- §4 tooling/structure → Task 1. ✅
- §5 reversing workflow → Task 2. ✅
- §6 Gemini + DeepSeek → Tasks 6, 7. ✅
- §7 MIT + attribution, new name/icons → Tasks 12 (About line), 13. ✅
- §8 testing (web-ext run, Vitest, manual) → throughout + Tasks 10/13. ✅
- §10.1 local-model base URL → Tasks 5, 7, 12. ✅
- Safety contract (no auto-save, backup-before-write) → Task 11. ✅

**Placeholder scan:** The two `NOTE:` markers (final name, `gecko.id`) are intentional identity decisions explicitly resolved in Task 13 Step 1 — not code placeholders. The `setFormatColumns` body in Task 4 is a verbatim port of source we already have in `reverse/bridge.original.js` (the SFC routine), documented in Task 2. No "TODO/implement later" in executable logic.

**Type consistency:** `Settings`, `AppSchema`, `Backup`, `AiProvider`, `CompletionRequest`, `Issue`, `BridgeAction`, `REQ_TAG`/`RES_TAG` are defined once and consumed with matching signatures across tasks. `runGeneration`/`buildPrompt`/`getProvider`/`getSchema`/`makeBackup`/`saveBackup` names are consistent between definition and use.
