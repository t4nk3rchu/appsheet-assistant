import type { AiProvider } from "./types";

export const gemini: AiProvider = {
  id: "gemini",
  label: "Google Gemini",
  async complete({ system, prompt, apiKey, model, baseUrl }) {
    const base = baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const m = model ?? "gemini-2.5-flash";
    const res = await fetch(`${base}/models/${m}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  },
};
