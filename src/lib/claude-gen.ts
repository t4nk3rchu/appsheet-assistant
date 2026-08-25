// src/lib/claude-gen.ts — unified generation entry for the tool tabs. Routes by
// provider/auth mode so the tabs don't each branch:
//   - gemini/deepseek, or Claude "api" mode → the existing background completion
//     (lib/ai.complete → provider or Anthropic API), full system+prompt.
//   - Claude "session" mode → a lean claude.ai message (slash-command the skill
//     or inject the spec once) via the background "claude-text" handler, with
//     optional live streaming and one-time schema priming.
import browser from "webextension-polyfill";
import { complete } from "./ai";
import { getSettings } from "./storage";
import { buildSchemaContext } from "./prompts";
import type { Table } from "./tables";

export interface GenOpts {
  needsSchema?: boolean; // include the app schema (once) — Build/Formula/Explain/Fix
  tables?: Table[]; // schema source (required when needsSchema)
  onStream?: (partial: string) => void; // live deltas (Ask AI, session mode only)
}

export async function runGen(system: string, prompt: string, opts: GenOpts = {}): Promise<string> {
  const s = await getSettings();
  // Everything except Claude-session goes through the normal completion path
  // (which already routes Claude "api" mode to the Anthropic API).
  if (s.provider !== "claude" || s.claudeAuthMode !== "session") {
    return complete(system, prompt);
  }

  const tables = opts.tables ?? [];
  const schemaText = opts.needsSchema ? buildSchemaContext(tables) : "";

  let streamId: string | undefined;
  let onMsg: ((m: unknown) => void) | undefined;
  if (opts.onStream) {
    streamId = `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    onMsg = (m: unknown) => {
      const d = m as { __hoc?: string; streamId?: string; text?: string };
      if (d?.__hoc === "claude-stream" && d.streamId === streamId) opts.onStream!(String(d.text ?? ""));
    };
    browser.runtime.onMessage.addListener(onMsg as any);
  }
  try {
    const res: any = await browser.runtime.sendMessage({
      __hoc: "claude-text", system, prompt, schemaText, tables,
      needsSchema: !!opts.needsSchema, skillSource: s.claudeSkillSource, skillName: s.claudeSkillName, streamId,
    });
    if (res?.needsLogin) throw new Error("Log into claude.ai, then try again.");
    if (res?.error) throw new Error(res.error);
    return res?.text ?? "";
  } finally {
    if (onMsg) browser.runtime.onMessage.removeListener(onMsg as any);
  }
}

/** Prime the claude.ai conversation with the current app schema once ("Check
 *  schema" in session mode), so later asks don't resend it. No-op result text. */
export async function primeSchema(tables: Table[]): Promise<void> {
  const res: any = await browser.runtime.sendMessage({
    __hoc: "claude-prime", schemaText: buildSchemaContext(tables), tables,
  });
  if (res?.needsLogin) throw new Error("Log into claude.ai, then try again.");
  if (res?.error) throw new Error(res.error);
}
