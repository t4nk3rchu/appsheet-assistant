import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMessage = vi.fn().mockResolvedValue(undefined);
const query = vi.fn().mockResolvedValue([{ id: 42 }]);
const create = vi.fn();
const toggle = vi.fn();
let onActionClicked: () => void;
const onMessageListeners: Array<(msg: any) => any> = [];

/**
 * The real browser fans a message out to every registered onMessage
 * listener. Mirror that here: dispatch to all listeners and return the
 * first result that isn't undefined (undefined means "not handled").
 */
async function dispatchMessage(msg: any): Promise<any> {
  for (const listener of onMessageListeners) {
    const result = listener(msg);
    if (result !== undefined) return result;
  }
  return undefined;
}

vi.mock("webextension-polyfill", () => ({
  default: {
    action: { onClicked: { addListener: (fn: any) => (onActionClicked = fn) } },
    sidebarAction: { toggle },
    tabs: {
      query,
      sendMessage,
      create,
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    runtime: { onMessage: { addListener: (fn: any) => onMessageListeners.push(fn) } },
  },
}));

const getSettings = vi.fn();
vi.mock("../src/lib/storage", () => ({
  getSettings: () => getSettings(),
}));

const complete = vi.fn();
const getProvider = vi.fn((_id: string) => ({ complete }));
vi.mock("../src/lib/providers", () => ({
  getProvider: (id: string) => getProvider(id),
}));

describe("background toolbar action", () => {
  beforeEach(() => vi.clearAllMocks());
  it("toggles the sidebar on toolbar-icon click (Firefox)", async () => {
    await import("../src/background/index");
    onActionClicked();
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

describe("background run-completion", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getSettings.mockResolvedValue({
      provider: "deepseek",
      apiKeys: { deepseek: "sk-test" },
      baseUrls: { deepseek: "https://custom.example" },
      darkMode: false,
    });
    complete.mockResolvedValue("OUT");
    await import("../src/background/index");
  });

  it("resolves { text } from the provider, using apiKey/baseUrl from settings", async () => {
    const res = await dispatchMessage({ __hoc: "run-completion", system: "s", prompt: "p" });
    expect(getProvider).toHaveBeenCalledWith("deepseek");
    expect(complete).toHaveBeenCalledWith({
      system: "s",
      prompt: "p",
      apiKey: "sk-test",
      baseUrl: "https://custom.example",
    });
    expect(res).toEqual({ text: "OUT" });
  });

  it("resolves { error } when the provider rejects", async () => {
    complete.mockRejectedValue(new Error("boom"));
    const res = await dispatchMessage({ __hoc: "run-completion", system: "s", prompt: "p" });
    expect(res).toEqual({ error: "boom" });
  });
});
