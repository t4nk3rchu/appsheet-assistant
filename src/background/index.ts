import browser from "webextension-polyfill";
import { getSettings } from "../lib/storage";
import { getProvider, anthropic } from "../lib/providers";
import type { Table } from "../lib/tables";
import { buildClaudeMessage, decideTurn, hashSchema, extractChangesetJson, type ClaudeTurnState } from "../lib/claude-msg";

// One managed claude.ai conversation. Reset when the tab closes.
let claudeTurn: ClaudeTurnState | null = null;

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

/** Find an existing claude.ai tab or open one; return its tabId. */
async function ensureClaudeTab(): Promise<number> {
  const tabs = await browser.tabs.query({ url: "https://claude.ai/*" });
  if (tabs[0]?.id != null) return tabs[0].id;
  claudeTurn = null; // fresh tab = fresh conversation
  const created = await browser.tabs.create({ url: "https://claude.ai/new", active: false });
  if (created.id == null) throw new Error("Could not open a claude.ai tab.");
  // Wait for the driver content script to be injectable (tab finishes loading),
  // but don't hang forever if the tab never reaches "complete".
  await new Promise<void>((resolve, reject) => {
    const onUpdated = (id: number, info: browser.Tabs.OnUpdatedChangeInfoType) => {
      if (id === created.id && info.status === "complete") {
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
  return created.id;
}

browser.tabs.onRemoved.addListener((tabId) => {
  // If the managed claude.ai tab closed, forget the conversation so the next
  // ask re-primes.
  browser.tabs.query({ url: "https://claude.ai/*" }).then((remaining) => {
    if (!remaining.some((tb) => tb.id === tabId) && remaining.length === 0) claudeTurn = null;
  });
});

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
    const settings = await getSettings();
    // API mode: the Anthropic API takes a system + user split directly — msg.system
    // already carries the full spec + schema (from changesetPrompt). No claude.ai tab.
    if (settings.claudeAuthMode === "api") {
      const raw = await anthropic.complete({ system: msg.system, prompt: msg.ask, apiKey: settings.apiKeys.claude ?? "", baseUrl: settings.baseUrls.claude });
      const json = extractChangesetJson(raw);
      return json ? { json } : { error: "No changeset JSON found in the reply." };
    }
    const tabId = await ensureClaudeTab();
    const schemaHash = hashSchema(msg.tables);
    const { primed, schemaChanged, next } = decideTurn(claudeTurn, schemaHash, tabId);
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
