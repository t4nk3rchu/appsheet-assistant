import { describe, it, expect, vi } from "vitest";
import { anthropic } from "../../src/lib/providers/anthropic";

describe("anthropic adapter", () => {
  it("posts to /v1/messages with x-api-key + version headers and system/user split", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await anthropic.complete({ system: "s", prompt: "p", apiKey: "sk-ant" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("sk-ant");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body);
    expect(body.system).toBe("s");
    expect(body.messages[0]).toEqual({ role: "user", content: "p" });
    expect(typeof body.max_tokens).toBe("number");
    expect(out).toBe("ok");
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "bad key" }));
    await expect(anthropic.complete({ system: "s", prompt: "p", apiKey: "x" })).rejects.toThrow(/401/);
  });

  it("honors a custom baseUrl", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [{ text: "y" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    await anthropic.complete({ system: "s", prompt: "p", apiKey: "k", baseUrl: "https://proxy.example" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://proxy.example/v1/messages");
  });
});
