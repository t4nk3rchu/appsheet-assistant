// src/lib/claude-msg.ts — pure helpers for the claude.ai connector. No DOM, no
// browser.* — safe to unit-test and to import from any world.
import type { Table } from "./tables";

/** Pull the outermost {…} JSON object out of a chat reply (fences/prose stripped). */
export function extractChangesetJson(text: string): string | null {
  let raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  return raw.slice(a, b + 1);
}

/** Stable short hash of the schema (names + types), for change detection. */
export function hashSchema(tables: Table[]): string {
  const sig = tables
    .map((t) => `${t.name}:${t.columns.map((c) => `${c.name}/${c.type}`).join(",")}`)
    .join(";");
  let h = 5381;
  for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export interface ClaudeTurnState {
  primed: boolean;
  schemaHash: string;
  tabId: number;
}

/** Decide what this turn needs. `primed` in the RESULT = was the conversation
 *  already primed BEFORE this turn (so we can skip the spec). Priming is
 *  per-tab: if the current tab id differs from the one we primed, treat the
 *  conversation as not primed (a different/new tab has no prior context). */
export function decideTurn(
  prev: ClaudeTurnState | null,
  schemaHash: string,
  tabId: number,
): { primed: boolean; schemaChanged: boolean; next: ClaudeTurnState } {
  const primed = !!prev?.primed && prev.tabId === tabId;
  const schemaChanged = !prev || prev.schemaHash !== schemaHash;
  return { primed, schemaChanged, next: { primed: true, schemaHash, tabId } };
}

/** Build the chat message to send to claude.ai in SESSION mode, for any tool.
 *  Leans on the conversation/skill rather than re-sending the full spec:
 *  - skillSource "account": trigger the uploaded skill with a slash command
 *    (`/<skillName> <prompt>`) — no spec/roleplay injected.
 *  - skillSource "primer": inject the full `system` (spec/roleplay) ONCE on the
 *    first turn (alreadyPrimed=false), then just the prompt.
 *  Schema (schemaText) is included only for schema-dependent tools (needsSchema)
 *  and only when it changed / wasn't sent yet — a one-time conversation prime. */
export function buildSessionMessage(args: {
  skillSource: "primer" | "account";
  skillName: string;
  system: string;
  prompt: string;
  schemaText: string;
  needsSchema: boolean;
  alreadyPrimed: boolean;
  schemaChanged: boolean;
}): string {
  const { skillSource, skillName, system, prompt, schemaText, needsSchema, alreadyPrimed, schemaChanged } = args;
  const parts: string[] = [];
  if (skillSource === "primer" && !alreadyPrimed) parts.push(system);
  if (needsSchema && schemaChanged) parts.push(schemaText);
  // "account" with a skill name triggers it by slash; an empty name (Gemini Gem,
  // which is auto-active on its URL) sends nothing extra — the Gem is the skill.
  const lead = skillSource === "account" && skillName ? `/${skillName} ` : "";
  parts.push(lead + prompt);
  return parts.join("\n\n");
}
