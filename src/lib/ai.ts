// src/lib/ai.ts — generic completion helper for the non-mutating tools
// (Formula / Explain / Fix / Ask / Types). The provider fetch runs in the
// background worker (only context with the host_permissions CORS bypass in
// Chrome MV3); callers only pass { system, prompt }.
import browser from "webextension-polyfill";

export async function complete(system: string, prompt: string): Promise<string> {
  const res: any = await browser.runtime.sendMessage({ __hoc: "run-completion", system, prompt });
  if (res?.error) throw new Error(res.error);
  return res?.text ?? "";
}
