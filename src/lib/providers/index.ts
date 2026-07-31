import type { AiProvider } from "./types";
import { gemini } from "./gemini";
import { deepseek } from "./deepseek";

export const PROVIDERS: Record<string, AiProvider> = { gemini, deepseek };
export function getProvider(id: string): AiProvider {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
