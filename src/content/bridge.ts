// src/content/bridge.ts — runs in MAIN world (page context). Exposes reads
// (app id/name/template/tables) and editor writes (setFormatColumns, plus the
// autofill engine: applyChanges / applyTypes) over the postMessage protocol.
// The DOM-automation writes need native React/CodeMirror access, which only the
// MAIN world has — so the whole engine lives here, not in the content script.
import { REQ_TAG, RES_TAG, type BridgeAction } from "../lib/messaging";
import { extractTables, type Table } from "../lib/tables";
import { setFormatColumns, applyChanges, applyTypes, editorReady } from "./autofill";

declare global {
  interface Window {
    currentApp?: () => any;
    __hocAppSheetBridge?: boolean;
    __hocBridgeListener?: (e: MessageEvent) => void;
  }
}

function app(): any {
  try {
    return typeof window.currentApp === "function" ? (window.currentApp() ?? null) : null;
  } catch {
    return null;
  }
}

// getTables — real data tables from currentApp().appTemplate.AppData.DataSchemas.
// The filtering/normalization lives in the pure extractTables() (see tables.ts,
// covered by tests/tables.test.ts); this just feeds it the live schema array.
function getTables(): Table[] {
  const schemas = app()?.appTemplate?.AppData?.DataSchemas;
  return Array.isArray(schemas) ? extractTables(schemas) : [];
}

async function handle(action: BridgeAction, payload: any): Promise<unknown> {
  switch (action) {
    case "ping":
      return { ok: true, hasCurrentApp: typeof window.currentApp === "function" };
    case "getAppTemplate":
      return app()?.appTemplate ?? null;
    // currentApp() in the live editor keeps id/name under appTemplate
    // (appTemplate.Id / .Name / .ShortName); the top-level appId/appName/id
    // fallbacks are kept for other AppSheet builds that may expose them there.
    case "getAppId":
      return app()?.appId ?? app()?.id ?? app()?.appTemplate?.Id ?? null;
    case "getAppName":
      return app()?.appName ?? app()?.appTemplate?.Name ?? app()?.appTemplate?.ShortName ?? null;
    case "getTables":
      return getTables();
    case "editorReady":
      return editorReady();
    case "setFormatColumns":
      return setFormatColumns(payload);
    case "applyChanges":
      return applyChanges(payload?.changes ?? []);
    case "applyTypes":
      return applyTypes(payload?.table, payload?.cols ?? []);
    default:
      throw new Error(`Unknown bridge action: ${action}`);
  }
}

async function onBridgeMessage(e: MessageEvent): Promise<void> {
  if (e.source !== window) return;
  const d: any = e.data;
  if (!d || d.__tag !== REQ_TAG) return;
  let reply: any;
  try {
    reply = { __tag: RES_TAG, id: d.id, result: await handle(d.action, d.payload) };
  } catch (err) {
    reply = { __tag: RES_TAG, id: d.id, error: err instanceof Error ? err.message : String(err) };
  }
  window.postMessage(reply, "*");
}

// MAIN-world scripts live with the PAGE, not the extension: reloading the
// extension re-injects this file, and the old listener persists on window.
// Without de-duping, one request would be handled N times (harmless for
// idempotent reads/set_column, but add_view created N duplicate views).
// Remove any prior listener before adding, so exactly one — the latest code —
// is ever active.
if (window.__hocBridgeListener) window.removeEventListener("message", window.__hocBridgeListener as any);
window.__hocBridgeListener = onBridgeMessage as any;
window.addEventListener("message", onBridgeMessage as any);
window.__hocAppSheetBridge = true;
// Build marker — lets us verify the tab actually loaded the latest bundle
// (Firefox keeps the old MAIN-world script until the tab is hard-reloaded).
const HOC_BUILD = "2026-08-21-step-2stage";
(window as any).__hocBuild = HOC_BUILD;
console.log("[HOC] AppSheet bridge loaded — build " + HOC_BUILD);
