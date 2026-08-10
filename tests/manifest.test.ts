// tests/manifest.test.ts
import { describe, it, expect } from "vitest";
import { buildManifest } from "../src/manifest";

describe("buildManifest", () => {
  it("firefox target uses background.scripts and gecko id", () => {
    const m = buildManifest("firefox") as any;
    expect(m.background.scripts).toEqual(["src/background/index.ts"]);
    expect(m.background.service_worker).toBeUndefined();
    expect(m.browser_specific_settings.gecko.id).toMatch(/@/);
    expect(m.browser_specific_settings.gecko.strict_min_version).toBe("142.0");
    // AMO rejects Firefox/Mozilla trademarks in the name.
    expect(m.name).not.toContain("Firefox");
    expect(m.browser_specific_settings.gecko.data_collection_permissions.required).toContain("websiteContent");
  });
  it("chrome target uses service_worker, no gecko settings", () => {
    const m = buildManifest("chrome") as any;
    expect(m.background.service_worker).toBe("src/background/index.ts");
    expect(m.background.scripts).toBeUndefined();
    expect(m.browser_specific_settings).toBeUndefined();
    expect(m.name).not.toContain("(Firefox)");
  });
  it("both declare the MAIN-world content script and host permissions for v1 providers", () => {
    for (const t of ["firefox", "chrome"] as const) {
      const m = buildManifest(t) as any;
      const worlds = m.content_scripts.map((c: any) => c.world);
      expect(worlds).toContain("MAIN");
      expect(m.host_permissions).toEqual(
        expect.arrayContaining([
          "https://www.appsheet.com/*",
          "https://generativelanguage.googleapis.com/*",
          "https://api.deepseek.com/*",
        ]),
      );
    }
  });
});
