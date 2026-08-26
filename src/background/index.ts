import browser from "webextension-polyfill";
import { getSettings } from "../lib/storage";
import { getProvider, anthropic } from "../lib/providers";
import type { Table } from "../lib/tables";
import { buildSessionMessage, decideTurn, hashSchema, type ClaudeTurnState } from "../lib/claude-msg";

// One managed claude.ai conversation. Reset when the tab closes.
let claudeTurn: ClaudeTurnState | null = null;

// Per-app session state (in-memory; sessions don't survive browser restart).
const appSessions: Record<string, { tabId?: number; chatUrl?: string }> = {};
let activeAppId: string | null = null;

// Toolbar icon toggles the assistant.
// Firefox: sidebar_action — toggle it on action click (a user gesture).
// Chrome: side_panel — tell Chrome to open the panel when the action is clicked.
const anyBrowser = browser as any;
if (anyBrowser.sidebarAction?.toggle) {
  browser.action.onClicked.addListener(() => {
    anyBrowser.sidebarAction.toggle();
  });
}
const chromeApi = (globalThis as any).chrome;
if (chromeApi?.sidePanel?.setPanelBehavior) {
  chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

// Chrome MV3: content-script/sidebar fetches don't get the host_permissions
// CORS bypass — only the background worker does — so provider network calls are
// routed through here. Callers only send { system, prompt }; API keys and
// settings never leave the background.
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as any;
  if (!msg || msg.__hoc !== "run-completion") return undefined;
  return runCompletion(msg.system, msg.prompt);
});

async function runCompletion(system: string, prompt: string): Promise<{ text: string } | { error: string }> {
  try {
    const settings = await getSettings();
    // "claude" is not a normal API provider: in "session" mode it drives the
    // claude.ai tab; in "api" mode it uses the Anthropic API with apiKeys.claude.
    if (settings.provider === "claude") {
      if (settings.claudeAuthMode === "api") {
        const text = await anthropic.complete({ system, prompt, apiKey: settings.apiKeys.claude ?? "", baseUrl: settings.baseUrls.claude });
        return { text };
      }
      return runClaudeComplete(system, prompt);
    }
    const provider = getProvider(settings.provider);
    const apiKey = settings.apiKeys[settings.provider] ?? "";
    const baseUrl = settings.baseUrls[settings.provider];
    const text = await provider.complete({ system, prompt, apiKey, baseUrl });
    return { text };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

/** Plain-text completion via claude.ai (for the non-Build tools). Sends
 *  system+prompt as one chat message and returns the raw reply (no JSON
 *  extraction, no schema/skill priming — those tools carry their own prompts). */
async function runClaudeComplete(system: string, prompt: string): Promise<{ text: string } | { error: string }> {
  const tabId = await ensureClaudeTab();
  const text = `${system}\n\n${prompt}`;
  const res: any = await browser.tabs.sendMessage(tabId, { __hoc: "claude-drive", text, expectJson: false });
  if (res?.needsLogin) return { error: "Log into claude.ai, then try again." };
  if (res?.error) return { error: res.error };
  return { text: res.text ?? "" };
}

/** Wait up to 15s for a tab to finish loading. */
function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onUpdated = (id: number, info: browser.Tabs.OnUpdatedChangeInfoType) => {
      if (id === tabId && info.status === "complete") {
        browser.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("claude.ai tab did not finish loading"));
    }, 15000);
    browser.tabs.onUpdated.addListener(onUpdated);
  });
}

/** Find or create a claude.ai tab for a specific app, navigating to its
 *  stored conversation URL when one exists. */
async function ensureClaudeTabForApp(appId: string): Promise<number> {
  const session = appSessions[appId] ?? (appSessions[appId] = {});

  // Re-use an existing tab if it's still open.
  if (session.tabId != null) {
    try {
      await browser.tabs.get(session.tabId);
      if (activeAppId !== appId) { claudeTurn = null; activeAppId = appId; }
      return session.tabId;
    } catch {
      delete session.tabId; // tab was closed
    }
  }

  // Find an open tab already at the stored conversation URL.
  if (session.chatUrl) {
    const existing = await browser.tabs.query({ url: `${session.chatUrl}*` });
    if (existing[0]?.id != null) {
      session.tabId = existing[0].id;
      if (activeAppId !== appId) { claudeTurn = null; activeAppId = appId; }
      return session.tabId;
    }
  }

  // Open a new tab — either the stored conversation or a fresh /new.
  const url = session.chatUrl ?? "https://claude.ai/new";
  const created = await browser.tabs.create({ url, active: false });
  if (created.id == null) throw new Error("Could not open a claude.ai tab.");
  await waitForTabLoad(created.id);
  session.tabId = created.id;
  if (activeAppId !== appId) { claudeTurn = null; activeAppId = appId; }
  return created.id;
}

/** Find any claude.ai tab (generic fallback when no app is active). */
async function ensureClaudeTab(): Promise<number> {
  if (activeAppId) return ensureClaudeTabForApp(activeAppId);
  const tabs = await browser.tabs.query({ url: "https://claude.ai/*" });
  if (tabs[0]?.id != null) return tabs[0].id;
  claudeTurn = null;
  const created = await browser.tabs.create({ url: "https://claude.ai/new", active: false });
  if (created.id == null) throw new Error("Could not open a claude.ai tab.");
  await waitForTabLoad(created.id);
  return created.id;
}

// Content-script → runtime.sendMessage goes to the background but may not reach
// extension pages (sidebar) directly in MV3. Relay claude-stream deltas so the
// sidebar's onMessage listener receives them.
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as any;
  if (msg?.__hoc !== "claude-stream" || msg.__relayed) return undefined;
  browser.runtime.sendMessage({ ...msg, __relayed: true }).catch(() => {});
  return undefined;
});

browser.tabs.onRemoved.addListener((tabId) => {
  // Clear the tabId from any app session using this tab (keep chatUrl for reconnect).
  for (const appId of Object.keys(appSessions)) {
    if (appSessions[appId].tabId === tabId) delete appSessions[appId].tabId;
  }
  browser.tabs.query({ url: "https://claude.ai/*" }).then((remaining) => {
    if (remaining.length === 0) claudeTurn = null;
  });
});

// Session-mode generation for ALL tools. Builds a lean message (slash-command
// the uploaded skill, or inject the spec once for "primer"), primes the schema
// once for schema-dependent tools, and returns the raw reply text (the Build tab
// extracts JSON from it). Optionally streams deltas to the sidebar via streamId.
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as any;
  if (!msg || msg.__hoc !== "claude-text") return undefined;
  return runClaudeText(msg);
});

async function runClaudeText(msg: {
  system: string; prompt: string; schemaText: string; tables: Table[];
  needsSchema: boolean; skillSource: "primer" | "account"; skillName: string; streamId?: string;
}): Promise<{ text: string } | { error: string } | { needsLogin: true }> {
  try {
    const tabId = await ensureClaudeTab();
    // Non-schema tools keep the existing schema hash so they don't reset priming.
    const schemaHash = msg.needsSchema ? hashSchema(msg.tables) : (claudeTurn?.schemaHash ?? "noschema");
    const { primed, schemaChanged, next } = decideTurn(claudeTurn, schemaHash, tabId);
    const text = buildSessionMessage({
      skillSource: msg.skillSource, skillName: msg.skillName, system: msg.system,
      prompt: msg.prompt, schemaText: msg.schemaText, needsSchema: msg.needsSchema,
      alreadyPrimed: primed, schemaChanged,
    });
    const res: any = await browser.tabs.sendMessage(tabId, { __hoc: "claude-drive", text, expectJson: false, streamId: msg.streamId });
    if (res?.needsLogin) return { needsLogin: true };
    if (res?.error) return { error: res.error };
    claudeTurn = next; // advance only on success
    return { text: res.text ?? "" };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

// "Check schema" in session mode: send the app schema to claude.ai once to prime
// the conversation, so later asks don't resend it.
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as any;
  if (!msg || msg.__hoc !== "claude-prime") return undefined;
  return runClaudePrime(msg);
});

async function runClaudePrime(msg: { schemaText: string; tables: Table[] }): Promise<{ ok: true } | { error: string } | { needsLogin: true }> {
  try {
    const tabId = await ensureClaudeTab();
    const text = `Here is the current AppSheet app schema — use it for the changesets and answers that follow:\n\n${msg.schemaText}`;
    const res: any = await browser.tabs.sendMessage(tabId, { __hoc: "claude-drive", text, expectJson: false });
    if (res?.needsLogin) return { needsLogin: true };
    if (res?.error) return { error: res.error };
    // Record that this schema is now primed so subsequent asks skip re-sending it.
    claudeTurn = { primed: claudeTurn?.primed ?? false, schemaHash: hashSchema(msg.tables), tabId };
    return { ok: true };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

// Prime a specific AppSheet app: navigate to its stored conversation (or create
// a new one), send the schema with app context, and store the chatUrl so future
// messages go to the same conversation.
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as any;
  if (!msg || msg.__hoc !== "claude-prime-app") return undefined;
  return runClaudePrimeApp(msg);
});

async function runClaudePrimeApp(msg: {
  appId: string; appName: string; schemaText: string; tables: Table[];
}): Promise<{ ok: true } | { error: string } | { needsLogin: true }> {
  try {
    const { appId, appName, schemaText } = msg;
    if (activeAppId !== appId) { claudeTurn = null; activeAppId = appId; }
    const tabId = await ensureClaudeTabForApp(appId);
    const text = `AppSheet app: ${appName} (ID: ${appId})\n\nHere is the current app schema — use it for changesets and answers that follow:\n\n${schemaText}`;
    const res: any = await browser.tabs.sendMessage(tabId, { __hoc: "claude-drive", text, expectJson: false });
    if (res?.needsLogin) return { needsLogin: true };
    if (res?.error) return { error: res.error };
    // Capture the conversation URL after first-message redirect (/new → /chat/uuid).
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (tab?.url?.includes("/chat/")) {
      appSessions[appId] = { ...(appSessions[appId] ?? {}), chatUrl: tab.url, tabId };
    }
    claudeTurn = { primed: true, schemaHash: hashSchema(msg.tables), tabId };
    return { ok: true };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

// Switch the active app without re-priming (sidebar detected an app change).
// Returns hasSession=true when a stored conversation exists for this app.
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as any;
  if (!msg || msg.__hoc !== "claude-switch-app") return undefined;
  const appId: string = msg.appId;
  const hasSession = !!appSessions[appId]?.chatUrl;
  if (activeAppId !== appId) { claudeTurn = null; activeAppId = appId; }
  return Promise.resolve({ ok: true, hasSession });
});

// Sign-in + status for the claude.ai session mode (settings UI).
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as any;
  if (msg?.__hoc === "claude-signin") return claudeSignin();
  if (msg?.__hoc === "claude-status") return claudeStatus();
  return undefined;
});

/** Open (or focus) a claude.ai tab so the user can log in. */
async function claudeSignin(): Promise<{ ok: true }> {
  const tabs = await browser.tabs.query({ url: "https://claude.ai/*" });
  if (tabs[0]?.id != null) await browser.tabs.update(tabs[0].id, { active: true });
  else await browser.tabs.create({ url: "https://claude.ai/new", active: true });
  return { ok: true };
}

/** Report whether the user is signed into claude.ai (probes the driver in an
 *  existing tab; does not open one). */
async function claudeStatus(): Promise<{ signedIn: boolean; hasTab: boolean }> {
  const tabs = await browser.tabs.query({ url: "https://claude.ai/*" });
  const id = tabs[0]?.id;
  if (id == null) return { signedIn: false, hasTab: false };
  try {
    const res: any = await browser.tabs.sendMessage(id, { __hoc: "claude-status" });
    return { signedIn: !!res?.signedIn, hasTab: true };
  } catch {
    return { signedIn: false, hasTab: true }; // tab exists but driver not ready (needs reload)
  }
}
