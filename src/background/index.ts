import browser from "webextension-polyfill";
import { getSettings } from "../lib/storage";
import { getProvider } from "../lib/providers";

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
    const provider = getProvider(settings.provider);
    const apiKey = settings.apiKeys[settings.provider] ?? "";
    const baseUrl = settings.baseUrls[settings.provider];
    const text = await provider.complete({ system, prompt, apiKey, baseUrl });
    return { text };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}
