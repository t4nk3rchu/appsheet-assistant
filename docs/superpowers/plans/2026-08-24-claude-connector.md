# Claude (claude.ai) Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Ask Claude" path to the Build tab that generates a changeset by driving the user's logged-in claude.ai chat, then reuses the existing validate → plan → Apply flow.

**Architecture:** Sidebar → background relay → a content-script driver on `claude.ai` that injects the prompt into the chat composer, waits for the reply, and extracts the JSON. The background manages one dedicated claude.ai tab and one persistent conversation. Generation happens in claude.ai (subscription, no API key). No local process, no MCP. Additive to the existing Gemini/DeepSeek BYOK path; human-in-loop Apply preserved.

**Tech Stack:** TypeScript, React, Vite + vite-plugin-web-extension, webextension-polyfill, Vitest. Firefox MV3 primary (`strict_min_version` 142).

## Global Constraints

- Firefox MV3 primary target; `strict_min_version` "142.0" (do not lower). Chrome is secondary — note the service-worker 30s-idle caveat but do not block on it.
- Add-on name must never contain "Firefox"/"Mozilla" (AMO trademark rule).
- MAIN-world bridge (`src/content/bridge.ts`) must NOT import `webextension-polyfill`. The new claude driver runs in the ISOLATED world and MAY use `browser.*`.
- Nothing auto-applies or auto-saves: claude.ai output only ever lands in the Changeset box; the user clicks Apply, then Save in AppSheet.
- The claude.ai path is additive — if it fails, the existing Generate (BYOK) path must still work unchanged.
- Only app structure (table/column names) + the user's ask + the returned JSON may cross to claude.ai. No row data, no secrets.
- Tests: `npm test` (vitest). Type-check: `npx tsc --noEmit`. Build: `$env:TARGET="firefox"; npx vite build` (PowerShell) — the `build:firefox` npm script uses POSIX inline env and fails on native PowerShell.

---

## File Structure

- **Create** `src/lib/claude-msg.ts` — pure helpers: JSON extraction, schema hashing, per-mode message framing, turn-state decision. Fully unit-tested.
- **Create** `tests/claude-msg.test.ts` — tests for the above.
- **Create** `src/content/claude-driver.ts` — ISOLATED-world content script on `claude.ai`: inject prompt, wait, extract reply. Manual-verified (DOM).
- **Create** `src/lib/claude-client.ts` — sidebar-side helper: `askClaude(...)` → background via `browser.runtime.sendMessage`.
- **Modify** `src/lib/storage.ts` — add `claudeSkillSource` + `claudeSkillName` settings.
- **Modify** `src/manifest.ts` — add `claude.ai` host permission + driver content script.
- **Modify** `src/background/index.ts` — managed claude.ai tab + relay + in-memory conversation state.
- **Modify** `src/sidebar/tabs.tsx` — "Ask Claude" button + wiring in `BuildApp`.
- **Modify** `src/sidebar/i18n.ts` — new UI strings.
- **Modify** `src/popup/App.tsx` — Skill-source + skill-name settings controls.

---

## Task 1: Settings — skill-source fields

**Files:**
- Modify: `src/lib/storage.ts:5-16`
- Test: `tests/claude-msg.test.ts` (created in Task 2; the settings-default check rides along there — no separate test file for a 2-field default)

**Interfaces:**
- Produces: `Settings.claudeSkillSource: "primer" | "account"`, `Settings.claudeSkillName: string`; `DEFAULTS` gains `claudeSkillSource: "primer"`, `claudeSkillName: "appsheet-architect"`.

- [ ] **Step 1: Add the fields to the `Settings` interface and `DEFAULTS`**

In `src/lib/storage.ts`, extend the interface:

```typescript
export interface Settings {
  provider: "gemini" | "deepseek";
  apiKeys: Record<string, string>;
  baseUrls: Record<string, string>;
  darkMode: boolean;
  lang: "vi" | "en";
  buildInstructions: string;
  // Claude (claude.ai) connector: how the changeset spec/skill reaches the chat.
  // "primer" = inject the spec as the first message; "account" = trigger a skill
  // the user uploaded via claude.ai Customize, by name.
  claudeSkillSource: "primer" | "account";
  claudeSkillName: string;
}
```

And the defaults line:

```typescript
const DEFAULTS: Settings = { provider: "gemini", apiKeys: {}, baseUrls: {}, darkMode: false, lang: "vi", buildInstructions: "", claudeSkillSource: "primer", claudeSkillName: "appsheet-architect" };
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/storage.ts
git commit -m "feat(claude): add skill-source settings fields"
```

---

## Task 2: Pure message helpers (`claude-msg.ts`)

**Files:**
- Create: `src/lib/claude-msg.ts`
- Test: `tests/claude-msg.test.ts`

**Interfaces:**
- Consumes: `Table` from `./tables` (for `hashSchema`).
- Produces:
  - `extractChangesetJson(text: string): string | null` — the outermost `{…}` object substring, fences/prose stripped; `null` if none.
  - `hashSchema(tables: Table[]): string` — stable short hash of table/column names+types.
  - `ClaudeTurnState = { primed: boolean; schemaHash: string }`
  - `decideTurn(prev: ClaudeTurnState | null, schemaHash: string): { primed: boolean; schemaChanged: boolean; next: ClaudeTurnState }` — `primed` here means "the conversation was ALREADY primed before this turn".
  - `buildClaudeMessage(args: { mode: "primer" | "account"; skillName: string; system: string; ask: string; schemaText: string; alreadyPrimed: boolean; schemaChanged: boolean }): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/claude-msg.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractChangesetJson, hashSchema, decideTurn, buildClaudeMessage } from "../src/lib/claude-msg";
import { getSettings } from "../src/lib/storage"; // note: not called; import kept out if it needs browser — see below

describe("extractChangesetJson", () => {
  it("returns clean JSON unchanged", () => {
    expect(extractChangesetJson('{"changes":[]}')).toBe('{"changes":[]}');
  });
  it("strips ```json fences", () => {
    expect(extractChangesetJson('```json\n{"changes":[]}\n```')).toBe('{"changes":[]}');
  });
  it("pulls the object out of surrounding prose", () => {
    expect(extractChangesetJson('Sure! Here you go:\n{"changes":[{"op":"x"}]}\nHope that helps'))
      .toBe('{"changes":[{"op":"x"}]}');
  });
  it("returns null when there is no object", () => {
    expect(extractChangesetJson("no json here")).toBeNull();
  });
});

describe("hashSchema", () => {
  const a = [{ name: "T", columns: [{ name: "c", type: "Text" }] }] as any;
  const b = [{ name: "T", columns: [{ name: "c", type: "Number" }] }] as any;
  it("is stable for the same input", () => {
    expect(hashSchema(a)).toBe(hashSchema(a));
  });
  it("changes when a column type changes", () => {
    expect(hashSchema(a)).not.toBe(hashSchema(b));
  });
});

describe("decideTurn", () => {
  it("first turn: not already primed, schema counts as changed", () => {
    const r = decideTurn(null, "h1");
    expect(r.primed).toBe(false);
    expect(r.schemaChanged).toBe(true);
    expect(r.next).toEqual({ primed: true, schemaHash: "h1" });
  });
  it("second turn, same schema: primed, no schema change", () => {
    const r = decideTurn({ primed: true, schemaHash: "h1" }, "h1");
    expect(r.primed).toBe(true);
    expect(r.schemaChanged).toBe(false);
  });
  it("second turn, changed schema: primed, schema changed", () => {
    const r = decideTurn({ primed: true, schemaHash: "h1" }, "h2");
    expect(r.primed).toBe(true);
    expect(r.schemaChanged).toBe(true);
    expect(r.next.schemaHash).toBe("h2");
  });
});

describe("buildClaudeMessage", () => {
  const base = { skillName: "appsheet-architect", system: "SPEC+RULES", ask: "add a bot", schemaText: "SCHEMA" };
  it("primer, first turn: includes the full spec + schema + ask", () => {
    const m = buildClaudeMessage({ ...base, mode: "primer", alreadyPrimed: false, schemaChanged: true });
    expect(m).toContain("SPEC+RULES");
    expect(m).toContain("SCHEMA");
    expect(m).toContain("add a bot");
  });
  it("primer, later turn, unchanged schema: no spec, no schema, just the ask", () => {
    const m = buildClaudeMessage({ ...base, mode: "primer", alreadyPrimed: true, schemaChanged: false });
    expect(m).not.toContain("SPEC+RULES");
    expect(m).not.toContain("SCHEMA");
    expect(m).toContain("add a bot");
  });
  it("account mode: triggers the skill by name, no full spec", () => {
    const m = buildClaudeMessage({ ...base, mode: "account", alreadyPrimed: false, schemaChanged: true });
    expect(m).toContain("appsheet-architect");
    expect(m).not.toContain("SPEC+RULES");
    expect(m).toContain("SCHEMA");
    expect(m).toContain("add a bot");
  });
});
```

Remove the unused `getSettings` import line — it pulls in `webextension-polyfill` and isn't needed here.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/claude-msg.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/claude-msg'`.

- [ ] **Step 3: Implement `claude-msg.ts`**

Create `src/lib/claude-msg.ts`:

```typescript
// src/lib/claude-msg.ts — pure helpers for the claude.ai connector. No DOM, no
// browser.* — safe to unit-test and to import from any world.
import type { Table } from "./tables";

/** Pull the outermost {…} JSON object out of a chat reply (fences/prose stripped). */
export function extractChangesetJson(text: string): string | null {
  let raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  return raw.slice(a, b + 1);
}

/** Stable short hash of the schema (names + types), for change detection. */
export function hashSchema(tables: Table[]): string {
  const sig = tables
    .map((t) => `${t.name}:${t.columns.map((c) => `${c.name}/${c.type}`).join(",")}`)
    .join(";");
  let h = 5381;
  for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export interface ClaudeTurnState {
  primed: boolean;
  schemaHash: string;
}

/** Decide what this turn needs. `primed` in the RESULT = was the conversation
 *  already primed BEFORE this turn (so we can skip the spec). */
export function decideTurn(
  prev: ClaudeTurnState | null,
  schemaHash: string,
): { primed: boolean; schemaChanged: boolean; next: ClaudeTurnState } {
  const primed = !!prev?.primed;
  const schemaChanged = !prev || prev.schemaHash !== schemaHash;
  return { primed, schemaChanged, next: { primed: true, schemaHash } };
}

/** Build the chat message text to send to claude.ai for this turn/mode. */
export function buildClaudeMessage(args: {
  mode: "primer" | "account";
  skillName: string;
  system: string; // full spec + rules (from changesetPrompt)
  ask: string;
  schemaText: string;
  alreadyPrimed: boolean;
  schemaChanged: boolean;
}): string {
  const { mode, skillName, system, ask, schemaText, alreadyPrimed, schemaChanged } = args;
  const parts: string[] = [];
  if (mode === "account") {
    // The uploaded skill carries the spec; we only trigger it + supply schema.
    if (schemaChanged) parts.push(schemaText);
    parts.push(`Use the ${skillName} skill to produce a changeset. Reply with the changeset JSON only, no prose.\n\n${ask}`);
  } else {
    // Primer: send the full spec on the first turn (or if the conversation was reset).
    if (!alreadyPrimed) parts.push(system);
    if (schemaChanged) parts.push(schemaText);
    parts.push(`${ask}\n\nReply with the changeset JSON only, no prose, no code fences.`);
  }
  return parts.join("\n\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/claude-msg.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/claude-msg.ts tests/claude-msg.test.ts
git commit -m "feat(claude): pure message helpers (extract/hash/turn/build) + tests"
```

---

## Task 3: claude.ai driver content script

**Files:**
- Create: `src/content/claude-driver.ts`

**Interfaces:**
- Consumes: `extractChangesetJson` from `../lib/claude-msg`.
- Produces (message contract): listens for `browser.runtime.onMessage` where `msg.__hoc === "claude-drive"` with `{ text: string }`; resolves to `{ json: string } | { error: string } | { needsLogin: true }`.

> **Selector note:** the composer / send / completion / message selectors below are best-effort and MUST be confirmed live against claude.ai in Task 7 (same iterative-selector model as the AppSheet driver). Keep them in the small helper functions so Task 7 can adjust one place.

- [ ] **Step 1: Implement the driver**

Create `src/content/claude-driver.ts`:

```typescript
// src/content/claude-driver.ts — ISOLATED-world content script on claude.ai.
// Drives one chat conversation: inject a message, wait for the reply to finish
// streaming, and return the extracted changeset JSON. Selectors are verified
// live (see the connector plan, Task 7).
import browser from "webextension-polyfill";
import { extractChangesetJson } from "../lib/claude-msg";

declare global {
  var chrome: { runtime?: { id?: string } } | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The chat composer (ProseMirror contenteditable). */
function composer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('div[contenteditable="true"].ProseMirror, div.ProseMirror[contenteditable="true"]');
}

/** True when we appear to be on a login screen (no composer + a login control). */
function needsLogin(): boolean {
  if (composer()) return false;
  return /\/login|\/onboarding/.test(location.pathname) ||
    !!document.querySelector('a[href*="/login"], button[data-testid="login"]');
}

/** Set the composer text (ProseMirror needs an input event, not just .textContent). */
function setComposer(el: HTMLElement, text: string): void {
  el.focus();
  // Replace content: select-all + insertText via execCommand is the most
  // ProseMirror-friendly path in a content script.
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand("insertText", false, text);
}

/** The Send button. */
function sendButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[aria-label="Send message"], button[aria-label="Send Message"]');
}

/** True while a response is streaming (a Stop button is present). */
function isStreaming(): boolean {
  return !!document.querySelector('button[aria-label="Stop response"], button[aria-label="Stop generating"]');
}

/** Text of the last assistant message block. */
function lastAssistantText(): string {
  const msgs = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="assistant-message"], div.font-claude-message'));
  const last = msgs[msgs.length - 1];
  return last ? (last.innerText || last.textContent || "") : "";
}

async function drive(text: string): Promise<{ json: string } | { error: string } | { needsLogin: true }> {
  if (needsLogin()) return { needsLogin: true };
  const el = composer();
  if (!el) return { error: "claude.ai composer not found (open a chat)." };

  setComposer(el, text);
  await sleep(150);
  const btn = sendButton();
  if (btn && !btn.disabled) {
    btn.click();
  } else {
    // Fallback: Enter submits in the ProseMirror composer.
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }

  // Wait for streaming to start (up to 8s), then for it to finish (up to 180s).
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !isStreaming()) await sleep(150);
  const t1 = Date.now();
  while (Date.now() - t1 < 180000 && isStreaming()) await sleep(300);
  if (isStreaming()) return { error: "claude.ai response timed out." };
  await sleep(400); // let the final chunk settle

  const reply = lastAssistantText();
  const json = extractChangesetJson(reply);
  if (!json) return { error: "No changeset JSON found in the reply." };
  return { json };
}

if (globalThis.chrome?.runtime?.id) {
  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as { __hoc?: string; text?: string } | undefined;
    if (msg?.__hoc !== "claude-drive" || typeof msg.text !== "string") return undefined;
    return drive(msg.text);
  });
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/content/claude-driver.ts
git commit -m "feat(claude): claude.ai driver content script (inject/wait/extract)"
```

---

## Task 4: Manifest — claude.ai host + driver content script

**Files:**
- Modify: `src/manifest.ts:17-34,63-64`

**Interfaces:**
- Produces: the built extension requests `https://claude.ai/*` and injects `src/content/claude-driver.ts` there.

- [ ] **Step 1: Add the host permission**

In `src/manifest.ts`, extend `host_permissions`:

```typescript
    host_permissions: [
      "https://www.appsheet.com/*",
      "https://generativelanguage.googleapis.com/*",
      "https://api.deepseek.com/*",
      "https://claude.ai/*",
    ],
```

- [ ] **Step 2: Add the driver content script**

Append to the `content_scripts` array (after the MAIN-world bridge entry):

```typescript
      {
        matches: ["https://claude.ai/*"],
        js: ["src/content/claude-driver.ts"],
        run_at: "document_idle",
      },
```

- [ ] **Step 3: Update the data-collection disclosure note**

Change the comment above `data_collection_permissions` to mention claude.ai:

```typescript
        // Data-collection disclosure. The AI-generation feature (optional)
        // transmits the open app's structure + your prompt to the AI provider you
        // configure, OR to your own logged-in claude.ai session. Everything else
        // stays on-device.
```

- [ ] **Step 4: Build and confirm the manifest**

Run (PowerShell): `$env:TARGET="firefox"; npx vite build`
Then: `node -e "const m=require('./dist/manifest.json'); console.log(m.host_permissions.includes('https://claude.ai/*'), m.content_scripts.some(c=>c.js.some(j=>j.includes('claude-driver'))))"`
Expected: `true true`

- [ ] **Step 5: Commit**

```bash
git add src/manifest.ts
git commit -m "feat(claude): manifest host permission + driver content script for claude.ai"
```

---

## Task 5: Background — managed tab, relay, conversation state

**Files:**
- Modify: `src/background/index.ts`

**Interfaces:**
- Consumes: `buildClaudeMessage`, `decideTurn`, `hashSchema`, `ClaudeTurnState` from `../lib/claude-msg`; `Table` from `../lib/tables`.
- Produces (message contract): handles `browser.runtime.onMessage` where `msg.__hoc === "claude-ask"` with `{ system: string; ask: string; schemaText: string; tables: Table[]; mode: "primer" | "account"; skillName: string }`; resolves to `{ json: string } | { error: string } | { needsLogin: true }`.

- [ ] **Step 1: Add the imports and in-memory state**

At the top of `src/background/index.ts`, after the existing imports:

```typescript
import type { Table } from "../lib/tables";
import { buildClaudeMessage, decideTurn, hashSchema, type ClaudeTurnState } from "../lib/claude-msg";

// One managed claude.ai conversation. Reset when the tab closes.
let claudeTurn: ClaudeTurnState | null = null;
```

- [ ] **Step 2: Add tab management + reset-on-close**

Add these helpers in `src/background/index.ts`:

```typescript
/** Find an existing claude.ai tab or open one; return its tabId. */
async function ensureClaudeTab(): Promise<number> {
  const tabs = await browser.tabs.query({ url: "https://claude.ai/*" });
  if (tabs[0]?.id != null) return tabs[0].id;
  claudeTurn = null; // fresh tab = fresh conversation
  const created = await browser.tabs.create({ url: "https://claude.ai/new", active: false });
  if (created.id == null) throw new Error("Could not open a claude.ai tab.");
  // Wait for the driver content script to be injectable (tab finishes loading).
  await new Promise<void>((resolve) => {
    const onUpdated = (id: number, info: browser.Tabs.OnUpdatedChangeInfoType) => {
      if (id === created.id && info.status === "complete") {
        browser.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    browser.tabs.onUpdated.addListener(onUpdated);
  });
  return created.id;
}

browser.tabs.onRemoved.addListener((tabId) => {
  // If the managed claude.ai tab closed, forget the conversation so the next
  // ask re-primes.
  browser.tabs.query({ url: "https://claude.ai/*" }).then((remaining) => {
    if (!remaining.some((tb) => tb.id === tabId) && remaining.length === 0) claudeTurn = null;
  });
});
```

- [ ] **Step 3: Add the `claude-ask` handler**

Add a second `onMessage` listener (leave the existing `run-completion` one intact):

```typescript
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as any;
  if (!msg || msg.__hoc !== "claude-ask") return undefined;
  return runClaudeAsk(msg);
});

async function runClaudeAsk(msg: {
  system: string; ask: string; schemaText: string; tables: Table[];
  mode: "primer" | "account"; skillName: string;
}): Promise<{ json: string } | { error: string } | { needsLogin: true }> {
  try {
    const tabId = await ensureClaudeTab();
    const schemaHash = hashSchema(msg.tables);
    const { primed, schemaChanged, next } = decideTurn(claudeTurn, schemaHash);
    const text = buildClaudeMessage({
      mode: msg.mode, skillName: msg.skillName, system: msg.system,
      ask: msg.ask, schemaText: msg.schemaText, alreadyPrimed: primed, schemaChanged,
    });
    const res: any = await browser.tabs.sendMessage(tabId, { __hoc: "claude-drive", text });
    if (res?.needsLogin) return { needsLogin: true };
    if (res?.error) return { error: res.error };
    // Only advance the conversation state once a turn actually succeeded.
    claudeTurn = next;
    return { json: res.json };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}
```

- [ ] **Step 4: Type-check + build**

Run: `npx tsc --noEmit`
Then (PowerShell): `$env:TARGET="firefox"; npx vite build`
Expected: no errors; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/background/index.ts
git commit -m "feat(claude): background managed tab + relay + conversation state"
```

---

## Task 6: Sidebar — client helper, Build-tab button, settings, strings

**Files:**
- Create: `src/lib/claude-client.ts`
- Modify: `src/sidebar/tabs.tsx:8-15,17-24,63-134`
- Modify: `src/sidebar/i18n.ts`
- Modify: `src/popup/App.tsx:13-31`

**Interfaces:**
- Consumes: the `claude-ask` background contract (Task 5); `getSettings` from `../lib/storage`; `changesetPrompt`, `buildSchemaContext` from `../lib/prompts`; `hashSchema` unused here (background owns it).
- Produces: `askClaude(system: string, ask: string, schemaText: string, tables: Table[], mode: "primer"|"account", skillName: string): Promise<string>` — resolves the extracted JSON string or throws (message includes the login hint).

- [ ] **Step 1: Create the sidebar client helper**

Create `src/lib/claude-client.ts`:

```typescript
// src/lib/claude-client.ts — sidebar → background relay for the claude.ai path.
// Mirrors lib/ai.ts complete(), but routes to the managed claude.ai tab.
import browser from "webextension-polyfill";
import type { Table } from "./tables";

export async function askClaude(
  system: string, ask: string, schemaText: string, tables: Table[],
  mode: "primer" | "account", skillName: string,
): Promise<string> {
  const res: any = await browser.runtime.sendMessage({
    __hoc: "claude-ask", system, ask, schemaText, tables, mode, skillName,
  });
  if (res?.needsLogin) throw new Error("Log into claude.ai, then try again.");
  if (res?.error) throw new Error(res.error);
  return res?.json ?? "";
}
```

- [ ] **Step 2: Add i18n strings**

In `src/sidebar/i18n.ts`, add to BOTH the `vi` and `en` dictionaries (match the existing `build_*` key style). Vietnamese:

```typescript
  build_askClaude: "Hỏi Claude",
  build_askingClaude: "Đang hỏi Claude…",
  build_claudeHint: "Dùng phiên claude.ai đang đăng nhập (không tốn API key).",
```

English:

```typescript
  build_askClaude: "Ask Claude",
  build_askingClaude: "Asking Claude…",
  build_claudeHint: "Uses your logged-in claude.ai session (no API key).",
```

- [ ] **Step 3: Wire the Build tab**

In `src/sidebar/tabs.tsx`, add the import (near line 7-8):

```typescript
import { askClaude } from "../lib/claude-client";
import { getSettings } from "../lib/storage";
import { buildSchemaContext } from "../lib/prompts";
```

Add state inside `BuildApp` (near the other `useState` calls, ~line 40):

```typescript
  const [askingClaude, setAskingClaude] = useState(false);
```

Add the handler next to `generate()` (~line 87):

```typescript
  async function askViaClaude() {
    reset();
    setAskingClaude(true);
    try {
      const live = await getTables().catch(() => [] as Table[]);
      const use = live.length ? live : tables;
      setTbls(use);
      if (!use.length) { setErr(t.build_editorNotReady); return; }
      const { system, prompt } = changesetPrompt(ask, use, lang, instructions, skills);
      const schemaText = buildSchemaContext(use);
      const s = await getSettings();
      let raw = (await askClaude(system, prompt, schemaText, use, s.claudeSkillSource, s.claudeSkillName)).trim();
      const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
      if (a >= 0 && b > a) raw = raw.slice(a, b + 1);
      let pretty = raw;
      try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* leave raw */ }
      setRawJson(pretty);
      validateText(pretty, use);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setAskingClaude(false);
    }
  }
```

Add the button in the `.row` beside Generate (~line 127-134). Note: the Claude button is NOT gated on `hasKey` (it uses the claude.ai session, not an API key):

```typescript
      <div className="row">
        <button className="btn btn-primary" disabled={busy || !ask.trim() || !hasKey} onClick={generate}>
          {busy ? t.generating : t.generate}
        </button>
        <button className="btn" disabled={askingClaude || !ask.trim()} onClick={askViaClaude}>
          {askingClaude ? t.build_askingClaude : t.build_askClaude}
        </button>
        <button className="btn" disabled={checking} onClick={check}>
          {checking ? t.build_checking : t.build_check}
        </button>
      </div>
      <p className="hint">{t.build_claudeHint}</p>
```

- [ ] **Step 4: Add the settings controls**

In `src/popup/App.tsx`, add before the dark-mode `<label>` (~line 28):

```tsx
      <label>Claude skill source{" "}
        <select value={s.claudeSkillSource} onChange={(e) => patch({ claudeSkillSource: e.target.value as any })}>
          <option value="primer">Inject spec (no setup)</option>
          <option value="account">Uploaded skill (by name)</option>
        </select>
      </label>
      {s.claudeSkillSource === "account" && (
        <label>Skill name{" "}
          <input value={s.claudeSkillName}
            onChange={(e) => patch({ claudeSkillName: e.target.value })} />
        </label>
      )}
```

- [ ] **Step 5: Type-check, test, build**

Run: `npx tsc --noEmit`
Then: `npm test`
Then (PowerShell): `$env:TARGET="firefox"; npx vite build`
Expected: no type errors; all tests pass; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/lib/claude-client.ts src/sidebar/tabs.tsx src/sidebar/i18n.ts src/popup/App.tsx
git commit -m "feat(claude): Ask Claude button, sidebar client, skill-source settings"
```

---

## Task 7: Live end-to-end verification (manual)

**Files:** none (verification only). DOM automation isn't unit-tested — this is the integration gate, per codebase convention.

**Interfaces:** exercises the full path: sidebar → background → driver → claude.ai → box → Apply.

- [ ] **Step 1: Load the built extension**

In Firefox/Zen: `about:debugging` → This Firefox → Load Temporary Add-on → `dist/manifest.json`. Confirm no load errors.

- [ ] **Step 2: Confirm the driver selectors on claude.ai (adjust if needed)**

Open `https://claude.ai/new` logged in. Via zen-mcp `zen_evaluate` (use bare/expression-bodied arrow + `JSON.stringify` — block-body IIFEs return null on throw), confirm each selector in `claude-driver.ts` resolves:
- composer: `!!document.querySelector('div[contenteditable="true"].ProseMirror')`
- send button: `!!document.querySelector('button[aria-label="Send message"]')`
- streaming/stop: send a message by hand, check the Stop button's `aria-label`.
- assistant message container: inspect the last reply block's selector.
Update the helper functions in `src/content/claude-driver.ts` for any that are wrong; rebuild; commit `fix(claude): correct claude.ai selectors`.

- [ ] **Step 3: Happy path — primer mode, first turn**

With an AppSheet editor tab open (VisiconDemo) and `claudeSkillSource = "primer"`: type "add a scheduled bot that emails USEREMAIL() every Monday 8am" → **Ask Claude**. Expected: a claude.ai tab opens/streams; the changeset JSON appears in the box; the plan shows ≥1 change; no parse error. Click **Apply** → the bot is created; then Save in AppSheet.

- [ ] **Step 4: Second turn — same schema (no re-prime)**

Without closing the claude.ai tab, ask a second changeset. Expected: the message does NOT re-send the full spec (verify in the claude.ai conversation that the 2nd user turn is short — just the ask); JSON still returns and validates.

- [ ] **Step 5: Account-skill mode**

Set `claudeSkillSource = "account"`, `claudeSkillName = "appsheet-architect"` (upload that skill in claude.ai Customize first). Ask a changeset. Expected: the user turn reads "Use the appsheet-architect skill…"; JSON returns and validates.

- [ ] **Step 6: Failure modes**

- Log out of claude.ai → Ask Claude → sidebar shows "Log into claude.ai".
- Close the claude.ai tab → Ask Claude → a new tab opens and re-primes.
- Confirm the existing **Generate** (Gemini/DeepSeek) button still works unchanged.

- [ ] **Step 7: Update memory + status doc**

Append the verified state to the memory file `appsheet-assistant-status.md` (build marker, what works, any selector gotchas found in Step 2). Commit any doc/spec changes.

---

## Self-Review

**Spec coverage:**
- Extension→claude.ai→box→Apply — Tasks 3/5/6/7. ✓
- Plain chat, managed tab, persistent conversation — Task 5 (`ensureClaudeTab`, `claudeTurn`). ✓
- 2-mode skill delivery (account/primer) as a user setting — Tasks 1, 2 (`buildClaudeMessage`), 6 (settings UI). ✓
- Schema fed first turn + on change — Task 2 (`decideTurn`/`hashSchema`), used in Task 5. ✓
- Human-in-loop Apply — Task 6 reuses existing validate/plan/Apply; no auto-apply. ✓
- Additive + fail-safe — Claude button is separate, not `hasKey`-gated; Generate untouched (Task 6). ✓
- Security: host permission + disclosure — Task 4; no API key — Task 6 (session-based). ✓
- Error/edge cases (login, tab closed, invalid JSON, timeout) — driver (Task 3) + background (Task 5) + Task 7 Step 6. ✓
- Testing: pure logic unit-tested (Task 2), DOM manual (Task 7) — matches spec. ✓

**Placeholder scan:** none — every code step has real code; selector-tentative code is flagged for live confirmation in Task 7 (not a placeholder — it runs, and is verified/corrected against the live DOM).

**Type consistency:** `claude-ask` / `claude-drive` message shapes match across `claude-client.ts` (Task 6) → background handler (Task 5) → driver (Task 3). `ClaudeTurnState`, `decideTurn`, `buildClaudeMessage`, `hashSchema` signatures match between Task 2 (definition) and Task 5 (use). `Settings.claudeSkillSource`/`claudeSkillName` match between Task 1 (definition), Task 6 (read + UI). Return shape `{ json | error | needsLogin }` consistent driver→background→client.

**Out of scope (deferred per spec):** live streaming of Claude's thinking into the sidebar; auto-fix invalid JSON via a follow-up turn; claude.ai/code; account-skill auto-detection. Not planned — correct.
