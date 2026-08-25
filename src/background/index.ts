import browser from "webextension-polyfill";
import { getSettings } from "../lib/storage";
import { getProvider } from "../lib/providers";
import type { Table } from "../lib/tables";
import { buildClaudeMessage, decideTurn, hashSchema, type ClaudeTurnState } from "../lib/claude-msg";

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
    // "claude" is a session provider (claude.ai), not an API provider — route the
    // plain-text completion through the managed claude.ai tab instead of getProvider.
    if (settings.provider === "claude") return runClaudeComplete(system, prompt);
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
