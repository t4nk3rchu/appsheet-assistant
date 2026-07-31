import { describe, it, expect, vi } from "vitest";
import { gemini } from "../../src/lib/providers/gemini";

describe("gemini adapter", () => {
  it("posts to generateContent and extracts text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "hello" }] } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await gemini.complete({ system: "sys", prompt: "hi", apiKey: "K" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain(":generateContent");
    expect(url).toContain("key=K");
    expect(JSON.parse(init.body).contents[0].parts[0].text).toBe("hi");
    expect(out).toBe("hello");
  });
  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "rate" }));
    await expect(gemini.complete({ system: "s", prompt: "p", apiKey: "K" })).rejects.toThrow(/429/);
  });
});
