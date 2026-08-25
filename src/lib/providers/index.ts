import type { AiProvider } from "./types";
import { gemini } from "./gemini";
import { deepseek } from "./deepseek";
import { anthropic } from "./anthropic";

// PROVIDERS = the API providers listed in the settings dropdown. "claude" is a
// separate dropdown entry with its own session/API sub-mode, so the anthropic
// adapter is exported for the background to use directly, not listed here.
export const PROVIDERS: Record<string, AiProvider> = { gemini, deepseek };
export { anthropic };
export function getProvider(id: string): AiProvider {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
