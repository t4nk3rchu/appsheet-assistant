// tests/storage.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const store: any = {};
vi.mock("webextension-polyfill", () => ({
  default: {
    storage: { local: {
      get: async (k: string) => ({ [k]: store[k] }),
      set: async (o: any) => Object.assign(store, o),
    } },
  },
}));
import { getSettings, saveSettings } from "../src/lib/storage";

describe("storage settings", () => {
  beforeEach(() => { for (const k in store) delete store[k]; });
  it("returns defaults when empty", async () => {
    const s = await getSettings();
    expect(s.provider).toBe("gemini");
    expect(s.darkMode).toBe(false);
    expect(s.apiKeys).toEqual({});
  });
  it("merges a patch on save", async () => {
    await saveSettings({ provider: "deepseek", apiKeys: { deepseek: "sk-x" } });
    const s = await getSettings();
    expect(s.provider).toBe("deepseek");
    expect(s.apiKeys.deepseek).toBe("sk-x");
    expect(s.darkMode).toBe(false); // untouched default preserved
  });
});
