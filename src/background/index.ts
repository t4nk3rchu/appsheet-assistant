import browser from "webextension-polyfill";
import { getSettings, type Settings } from "../lib/storage";
import { getProvider, anthropic } from "../lib/providers";
import type { Table } from "../lib/tables";
import { buildSessionMessage, decideTurn, hashSchema, type ClaudeTurnState } from "../lib/claude-msg";

// One managed chat conversation (claude.ai or gemini.google.com). Reset on switch/close.
let sessionTurn: ClaudeTurnState | null = null;

// Per-app session state (in-memory; not persisted across browser restart).
// Keyed by `${provider}:${appId}` so Claude and Gemini sessions never collide.
const appSessions: Record<string, { tabId?: number; chatUrl?: string }> = {};
let activeKey: string | null = null;

// A session connector describes one chat site we drive in a tab. The DOM
// selectors live in the per-site content script (claude-driver / gemini-driver);
// this is only what the background needs to route tabs and messages.
interface Connector {
  provider: "claude" | "gemini";
  hostGlob: string; // tabs.query URL match
  driveMsg: string; // message tag the content-script driver listens for
  statusMsg: string; // signed-in probe tag
  newChatUrl: string; // where a fresh conversation starts
  isConvoUrl: (u: string) => boolean; // has the URL become a saved conversation?
}

function connectorFor(provider: string, s: Settings): Connector {
  if (provider === "gemini") {
    return {
      provider: "gemini",
      hostGlob: "https://gemini.google.com/*",
      driveMsg: "gemini-drive",
      statusMsg: "gemini-status",
      newChatUrl: s.geminiGemUrl?.trim() || "https://gemini.google.com/app",
      // A Gem conversation is /gem/<id>/<convoId>; a plain chat is /app/<convoId>.
      isConvoUrl: (u) => /\/gem\/[^/]+\/[^/?#]+/.test(u) || /\/app\/[^/?#]+/.test(u),
    };
  }
  return {
    provider: "claude",
    hostGlob: "https://claude.ai/*",
    driveMsg: "claude-drive",
    statusMsg: "claude-status",
    newChatUrl: "https://claude.ai/new",
    isConvoUrl: (u) => u.includes("/chat/"),
  };
}

const keyFor = (provider: string, appId: string) => `${provider}:${appId}`;

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
      return runSessionComplete(connectorFor("claude", settings), system, prompt);
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

/** Plain-text completion via a driven tab (fallback path). */
async function runSessionComplete(conn: Connector, system: string, prompt: string): Promise<{ text: string } | { error: string }> {
  const tabId = await ensureSessionTab(conn);
  const text = `${system}\n\n${prompt}`;
  const res: any = await browser.tabs.sendMessage(tabId, { __hoc: conn.driveMsg, text, expectJson: false });
  if (res?.needsLogin) return { error: `Log into ${conn.provider === "gemini" ? "gemini.google.com" : "claude.ai"}, then try again.` };
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
      reject(new Error("chat tab did not finish loading"));
    }, 15000);
    browser.tabs.onUpdated.addListener(onUpdated);
  });
}

/** Find or create a tab for a specific app's conversation. Prefers reusing an
 *  open tab (stored one → stored URL → any tab on the host) over a new one. */
async function ensureSessionTabForApp(conn: Connector, appId: string): Promise<number> {
  const key = keyFor(conn.provider, appId);
  const session = appSessions[key] ?? (appSessions[key] = {});
  const activate = () => { if (activeKey !== key) { sessionTurn = null; activeKey = key; } };

  // Re-use the stored tab if still open.
  if (session.tabId != null) {
    try {
      await browser.tabs.get(session.tabId);
      activate();
      return session.tabId;
    } catch {
      delete session.tabId;
    }
  }

  // Find an open tab already at the stored conversation URL.
  if (session.chatUrl) {
    const byUrl = await browser.tabs.query({ url: `${session.chatUrl}*` });
    if (byUrl[0]?.id != null) {
      session.tabId = byUrl[0].id;
      activate();
      return session.tabId;
    }
  }

  // Reuse any open tab on this host rather than opening a new one.
  const anyTabs = await browser.tabs.query({ url: conn.hostGlob });
  if (anyTabs[0]?.id != null) {
    session.tabId = anyTabs[0].id!;
    // Navigate it to the stored conversation (or the new-chat entry) if it's elsewhere.
    const dest = session.chatUrl ?? conn.newChatUrl;
    const cur = anyTabs[0].url ?? "";
    if (!cur.startsWith(dest.split("?")[0])) {
      await browser.tabs.update(session.tabId, { url: dest });
      await waitForTabLoad(session.tabId);
    }
    activate();
    return session.tabId;
  }

  // No tab on this host at all — open one.
  const url = session.chatUrl ?? conn.newChatUrl;
  const created = await browser.tabs.create({ url, active: false });
  if (created.id == null) throw new Error(`Could not open a ${conn.provider} tab.`);
  await waitForTabLoad(created.id);
  session.tabId = created.id;
  activate();
  return created.id;
}

/** Find any tab on the connector's host (generic fallback when no app is active). */
async function ensureSessionTab(conn: Connector): Promise<number> {
  if (activeKey?.startsWith(`${conn.provider}:`)) {
    return ensureSessionTabForApp(conn, activeKey.slice(conn.provider.length + 1));
  }
  const tabs = await browser.tabs.query({ url: conn.hostGlob });
  if (tabs[0]?.id != null) return tabs[0].id;
  sessionTurn = null;
  const created = await browser.tabs.create({ url: conn.newChatUrl, active: false });
  if (created.id == null) throw new Error(`Could not open a ${conn.provider} tab.`);
  await waitForTabLoad(created.id);
  return created.id;
}

// Content-script → runtime.sendMessage goes to the background but may not reach
// extension pages (sidebar) directly in MV3. Relay *-stream deltas so the
// sidebar's onMessage listener receives them.
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as any;
  if (typeof msg?.__hoc !== "string" || !msg.__hoc.endsWith("-stream") || msg.__relayed) return undefined;
  browser.runtime.sendMessage({ ...msg, __relayed: true }).catch(() => {});
  return undefined;
});

browser.tabs.onRemoved.addListener((tabId) => {
  // Clear the tabId from any app session using this tab (keep chatUrl for reconnect).
  for (const key of Object.keys(appSessions)) {
    if (appSessions[key].tabId === tabId) delete appSessions[key].tabId;
  }
});

// Session-mode generation for ALL tools. Builds a lean message (Claude:
// slash-command the skill or inject the spec once; Gemini: the Gem holds the
// instructions, so just schema-once + prompt), primes the schema once for
// schema-dependent tools, and returns the raw reply text (the Build tab extracts
// JSON from it). Optionally streams deltas to the sidebar via streamId.
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as any;
  if (!msg || msg.__hoc !== "session-generate") return undefined;
  return runSessionGenerate(msg);
});

async function runSessionGenerate(msg: {
  provider: string; system: string; prompt: string; schemaText: string; tables: Table[];
  needsSchema: boolean; skillSource: "primer" | "account"; skillName: string; streamId?: string;
}): Promise<{ text: string } | { error: string } | { needsLogin: true }> {
  try {
    const settings = await getSettings();
    const conn = connectorFor(msg.provider, settings);
    const tabId = await ensureSessionTab(conn);
    const schemaHash = msg.needsSchema ? hashSchema(msg.tables) : (sessionTurn?.schemaHash ?? "noschema");
    const { primed, schemaChanged, next } = decideTurn(sessionTurn, schemaHash, tabId);
    // Gemini: the Gem carries the instructions, so don't inject the spec/skill —
    // send schema-once + prompt (account source with an empty skill name = no slash).
    const gem = conn.provider === "gemini";
    const text = buildSessionMessage({
      skillSource: gem ? "account" : msg.skillSource,
      skillName: gem ? "" : msg.skillName,
      system: msg.system, prompt: msg.prompt, schemaText: msg.schemaText,
      needsSchema: msg.needsSchema, alreadyPrimed: primed, schemaChanged,
    });
    const res: any = await browser.tabs.sendMessage(tabId, { __hoc: conn.driveMsg, text, expectJson: false, streamId: msg.streamId });
    if (res?.needsLogin) return { needsLogin: true };
    if (res?.error) return { error: res.error };
    sessionTurn = next; // advance only on success
    return { text: res.text ?? "" };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

// Prime a specific AppSheet app: navigate to its stored conversation (or start a
// new one), send the schema with app context, and store the chatUrl so future
// messages go to the same conversation.
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as any;
  if (!msg || msg.__hoc !== "session-prime-app") return undefined;
  return runSessionPrimeApp(msg);
});

async function runSessionPrimeApp(msg: {
  provider: string; appId: string; appName: string; schemaText: string; tables: Table[];
}): Promise<{ ok: true } | { error: string } | { needsLogin: true }> {
  try {
    const { provider, appId, appName, schemaText } = msg;
    const settings = await getSettings();
    const conn = connectorFor(provider, settings);
    const key = keyFor(provider, appId);
    if (activeKey !== key) { sessionTurn = null; activeKey = key; }
    const tabId = await ensureSessionTabForApp(conn, appId);
    const text = `AppSheet app: ${appName} (ID: ${appId})\n\nHere is the current app schema — use it for changesets and answers that follow:\n\n${schemaText}`;
    const res: any = await browser.tabs.sendMessage(tabId, { __hoc: conn.driveMsg, text, expectJson: false });
    if (res?.needsLogin) return { needsLogin: true };
    if (res?.error) return { error: res.error };
    // Capture the conversation URL after the first-message redirect. Retry once —
    // the redirect may not have settled by the time drive() returns.
    let tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab?.url || !conn.isConvoUrl(tab.url)) {
      await new Promise<void>((r) => setTimeout(r, 600));
      tab = await browser.tabs.get(tabId).catch(() => null);
    }
    if (tab?.url && conn.isConvoUrl(tab.url)) {
      appSessions[key] = { ...(appSessions[key] ?? {}), chatUrl: tab.url, tabId };
    }
    sessionTurn = { primed: true, schemaHash: hashSchema(msg.tables), tabId };
    return { ok: true };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

// Switch the active app without re-priming (sidebar detected an app change).
// Returns hasSession=true when a stored conversation exists for this app.
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as any;
  if (!msg || msg.__hoc !== "session-switch-app") return undefined;
  const key = keyFor(msg.provider, msg.appId);
  const hasSession = !!appSessions[key]?.chatUrl;
  if (activeKey !== key) { sessionTurn = null; activeKey = key; }
  return Promise.resolve({ ok: true, hasSession });
});

// Sign-in + status for session mode (settings UI). Carries the provider.
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as any;
  if (msg?.__hoc === "session-signin") return sessionSignin(msg.provider);
  if (msg?.__hoc === "session-status") return sessionStatus(msg.provider);
  return undefined;
});

/** Open (or focus) the site so the user can log in. */
async function sessionSignin(provider: string): Promise<{ ok: true }> {
  const conn = connectorFor(provider, await getSettings());
  const tabs = await browser.tabs.query({ url: conn.hostGlob });
  if (tabs[0]?.id != null) await browser.tabs.update(tabs[0].id, { active: true });
  else await browser.tabs.create({ url: conn.newChatUrl, active: true });
  return { ok: true };
}

/** Report whether the user is signed in (probes the driver in an existing tab;
 *  does not open one). */
async function sessionStatus(provider: string): Promise<{ signedIn: boolean; hasTab: boolean }> {
  const conn = connectorFor(provider, await getSettings());
  const tabs = await browser.tabs.query({ url: conn.hostGlob });
  const id = tabs[0]?.id;
  if (id == null) return { signedIn: false, hasTab: false };
  try {
    const res: any = await browser.tabs.sendMessage(id, { __hoc: conn.statusMsg });
    return { signedIn: !!res?.signedIn, hasTab: true };
  } catch {
    return { signedIn: false, hasTab: true }; // tab exists but driver not ready (needs reload)
  }
}
