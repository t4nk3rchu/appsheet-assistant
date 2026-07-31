import { describe, it, expect, vi } from "vitest";
import { deepseek } from "../../src/lib/providers/deepseek";
import { getProvider } from "../../src/lib/providers";

describe("deepseek adapter", () => {
  it("posts OpenAI-style chat/completions with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await deepseek.complete({ system: "s", prompt: "p", apiKey: "sk-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-1");
    const body = JSON.parse(init.body);
    expect(body.messages[0]).toEqual({ role: "system", content: "s" });
    expect(body.messages[1]).toEqual({ role: "user", content: "p" });
    expect(out).toBe("ok");
  });
  it("registry resolves by id and throws on unknown", () => {
    expect(getProvider("deepseek").id).toBe("deepseek");
    expect(() => getProvider("nope")).toThrow();
  });
});
