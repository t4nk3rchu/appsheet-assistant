// tests/messaging.test.ts
import { describe, it, expect, vi } from "vitest";
import { sendToBridge, REQ_TAG, RES_TAG } from "../src/lib/messaging";

describe("sendToBridge", () => {
  it("posts a tagged request and resolves on the matching response", async () => {
    const posts: any[] = [];
    vi.stubGlobal("window", {
      postMessage: (m: any) => {
        posts.push(m);
        // simulate bridge replying
        const handler = (window as any)._listener;
        handler({ source: window, data: { __tag: RES_TAG, id: m.id, result: "pong" } });
      },
      addEventListener: (_: string, fn: any) => ((window as any)._listener = fn),
      removeEventListener: () => {},
    });
    const res = await sendToBridge<string>("ping");
    expect(posts[0].__tag).toBe(REQ_TAG);
    expect(posts[0].action).toBe("ping");
    expect(res).toBe("pong");
  });
});
