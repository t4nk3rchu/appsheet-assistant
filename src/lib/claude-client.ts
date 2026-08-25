// src/lib/claude-client.ts — sidebar → background relay for the claude.ai path.
// Mirrors lib/ai.ts complete(), but routes to the managed claude.ai tab.
import browser from "webextension-polyfill";
import type { Table } from "./tables";

export async function askClaude(
  system: string, ask: string, schemaText: string, tables: Table[],
  mode: "primer" | "account", skillName: string,
): Promise<string> {
  const res: any = await browser.runtime.sendMessage({
    __hoc: "claude-ask", system, ask, schemaText, tables, mode, skillName,
  });
  if (res?.needsLogin) throw new Error("Log into claude.ai, then try again.");
  if (res?.error) throw new Error(res.error);
  return res?.json ?? "";
}
