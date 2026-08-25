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
}

/** Decide what this turn needs. `primed` in the RESULT = was the conversation
 *  already primed BEFORE this turn (so we can skip the spec). */
export function decideTurn(
  prev: ClaudeTurnState | null,
  schemaHash: string,
): { primed: boolean; schemaChanged: boolean; next: ClaudeTurnState } {
  const primed = !!prev?.primed;
  const schemaChanged = !prev || prev.schemaHash !== schemaHash;
  return { primed, schemaChanged, next: { primed: true, schemaHash } };
}

/** Build the chat message text to send to claude.ai for this turn/mode. */
export function buildClaudeMessage(args: {
  mode: "primer" | "account";
  skillName: string;
  system: string; // full spec + rules (from changesetPrompt)
  ask: string;
  schemaText: string;
  alreadyPrimed: boolean;
  schemaChanged: boolean;
}): string {
  const { mode, skillName, system, ask, schemaText, alreadyPrimed, schemaChanged } = args;
  const parts: string[] = [];
  if (mode === "account") {
    // The uploaded skill carries the spec; we only trigger it + supply schema.
    if (schemaChanged) parts.push(schemaText);
    parts.push(`Use the ${skillName} skill to produce a changeset. Reply with the changeset JSON only, no prose.\n\n${ask}`);
  } else {
    // Primer: send the full spec on the first turn (or if the conversation was reset).
    if (!alreadyPrimed) parts.push(system);
    if (schemaChanged) parts.push(schemaText);
    parts.push(`${ask}\n\nReply with the changeset JSON only, no prose, no code fences.`);
  }
  return parts.join("\n\n");
}
