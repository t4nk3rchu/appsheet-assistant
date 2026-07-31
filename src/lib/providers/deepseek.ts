import type { AiProvider } from "./types";

export const deepseek: AiProvider = {
  id: "deepseek",
  label: "DeepSeek",
  async complete({ system, prompt, apiKey, model, baseUrl }) {
    const base = baseUrl ?? "https://api.deepseek.com";
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model ?? "deepseek-chat",
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  },
};
