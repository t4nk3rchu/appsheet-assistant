// src/lib/bridge-client.ts — runs in an extension page (sidebar / popup).
//
// The sidebar is a separate document, so it can't postMessage the MAIN-world
// bridge directly. Instead it sends to the active AppSheet tab's content
// script (isolated world), which relays to the bridge via window.postMessage
// (see src/content/index.ts) and returns the result.
//
// NOTE: kept separate from lib/messaging.ts on purpose — messaging.ts is
// imported by the MAIN-world bridge, which must NOT bundle
// webextension-polyfill (there is no browser.* in the page world).
import browser from "webextension-polyfill";
import type { BridgeAction } from "./messaging";

export async function callBridge<T = unknown>(action: BridgeAction, payload?: unknown): Promise<T> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) throw new Error("No active tab");
  let res: any;
  try {
    res = await browser.tabs.sendMessage(tab.id, { __hoc: "bridge", action, payload });
  } catch {
    throw new Error("Open an AppSheet editor tab, then try again");
  }
  if (res?.error) throw new Error(res.error);
  return res?.result as T;
}
