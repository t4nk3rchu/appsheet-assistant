import { describe, it, expect } from "vitest";
import { makeBackup } from "../src/lib/backup";

describe("makeBackup", () => {
  it("snapshots the schema with a timestamp and id", () => {
    const schema = { appId: "A1", appName: "My App", appTemplate: { tables: ["T"] } };
    const b = makeBackup(schema, 1000);
    expect(b.appId).toBe("A1");
    expect(b.appName).toBe("My App");
    expect(b.appTemplate).toEqual({ tables: ["T"] });
    expect(b.createdAt).toBe(1000);
    expect(b.id).toContain("1000");
  });
});
