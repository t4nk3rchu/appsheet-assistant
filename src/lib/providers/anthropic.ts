import type { AiProvider } from "./types";

// Anthropic Messages API adapter — the "API key" mode of the Claude provider
// (the other mode drives the claude.ai session; see src/content/claude-driver.ts).
// The direct-browser-access header lets the background worker call the API from
// an extension origin without a CORS preflight rejection.
export const anthropic: AiProvider = {
  id: "anthropic",
  label: "Claude (API)",
  async complete({ system, prompt, apiKey, model, baseUrl }) {
    const base = baseUrl ?? "https://api.anthropic.com";
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: model ?? "claude-sonnet-5",
        max_tokens: 8192,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.content?.[0]?.text ?? "";
  },
};
