// src/lib/claude-gen.ts — unified generation entry for the tool tabs. Routes by
// provider/auth mode so the tabs don't each branch:
//   - gemini/deepseek/claude in "api" mode → the existing background completion
//     (lib/ai.complete → provider or Anthropic API), full system+prompt.
//   - Claude or Gemini in "session" mode → a lean message driven into the
//     logged-in claude.ai / gemini.google.com tab via the background
//     "session-generate" handler, with optional live streaming and one-time
//     schema priming. Claude leans on an uploaded skill or a primer; Gemini
//     leans on the Gem (which holds the instructions).
import browser from "webextension-polyfill";
import { complete } from "./ai";
import { getSettings, type Settings } from "./storage";
import { buildSchemaContext } from "./prompts";
import type { Table } from "./tables";

export interface GenOpts {
  needsSchema?: boolean; // include the app schema (once) — Build/Formula/Explain/Fix
  tables?: Table[]; // schema source (required when needsSchema)
  onStream?: (partial: string) => void; // live deltas (Ask AI, session mode only)
}

/** True when the current provider is driving a logged-in tab (no API key). */
export function isSessionMode(s: Settings): boolean {
  return (s.provider === "claude" && s.claudeAuthMode === "session") ||
    (s.provider === "gemini" && s.geminiAuthMode === "session");
}

export async function runGen(system: string, prompt: string, opts: GenOpts = {}): Promise<string> {
  const s = await getSettings();
  // Everything except session mode goes through the normal completion path.
  if (!isSessionMode(s)) return complete(system, prompt);

  const tables = opts.tables ?? [];
  const schemaText = opts.needsSchema ? buildSchemaContext(tables) : "";

  let streamId: string | undefined;
  let onMsg: ((m: unknown) => void) | undefined;
  if (opts.onStream) {
    streamId = `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    onMsg = (m: unknown) => {
      const d = m as { __hoc?: string; streamId?: string; text?: string };
      if (d?.__hoc?.endsWith("-stream") && d.streamId === streamId) opts.onStream!(String(d.text ?? ""));
    };
    browser.runtime.onMessage.addListener(onMsg as any);
  }
  try {
    const res: any = await browser.runtime.sendMessage({
      __hoc: "session-generate", provider: s.provider, system, prompt, schemaText, tables,
      needsSchema: !!opts.needsSchema, skillSource: s.claudeSkillSource, skillName: s.claudeSkillName, streamId,
    });
    if (res?.needsLogin) throw new Error("Log into your AI session, then try again.");
    if (res?.error) throw new Error(res.error);
    return res?.text ?? "";
  } finally {
    if (onMsg) browser.runtime.onMessage.removeListener(onMsg as any);
  }
}

/** Prime the session for a specific AppSheet app: navigates to (or creates) the
 *  app's dedicated conversation and sends the schema with app context so the AI
 *  knows which app it's working on. Works for both Claude and Gemini. */
export async function primeApp(provider: string, appId: string, appName: string, tables: Table[]): Promise<void> {
  const res: any = await browser.runtime.sendMessage({
    __hoc: "session-prime-app", provider, appId, appName,
    schemaText: buildSchemaContext(tables), tables,
  });
  if (res?.needsLogin) throw new Error("Log into your AI session, then try again.");
  if (res?.error) throw new Error(res.error);
}
