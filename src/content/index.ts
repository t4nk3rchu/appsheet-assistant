// src/content/index.ts — runs in the ISOLATED world.
//
// This is now a thin relay, not a UI host: the assistant UI lives in the
// sidebar (a separate extension page). The sidebar can't postMessage the
// MAIN-world bridge directly, so it sends { __hoc: "bridge", action, payload }
// here via tabs.sendMessage, and this script forwards to the bridge over
// window.postMessage (sendToBridge) and returns the result.
//
// All imports are static and hoisted above the guard by the module spec — this
// file must stay a single bundled entry point with no dynamic import().
import browser from "webextension-polyfill";
import { sendToBridge } from "../lib/messaging";

// No @types/chrome dependency (webextension-polyfill covers the typed surface);
// this is the minimal shape the guard below needs.
declare global {
  var chrome: { runtime?: { id?: string } } | undefined;
}

// Guard first, before touching anything extension-scoped: after an extension
// reload/update, a stale content script keeps running with a dead
// chrome.runtime (chrome.runtime.id reads undefined). Referencing browser.*
// past this point would throw "Extension context invalidated."
if (!globalThis.chrome?.runtime?.id) {
  console.warn("[AppSheet Assistant] Context invalidated — refresh the tab to reload the helper.");
} else {
  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as { __hoc?: string; action?: any; payload?: unknown } | undefined;
    if (msg?.__hoc !== "bridge") return undefined;
    return sendToBridge(msg.action, msg.payload)
      .then((result) => ({ result }))
      .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  });
}
