import { describe, it, expect } from "vitest";
import { extractChangesetJson, hashSchema, decideTurn, buildSessionMessage } from "../src/lib/claude-msg";

describe("extractChangesetJson", () => {
  it("returns clean JSON unchanged", () => {
    expect(extractChangesetJson('{"changes":[]}')).toBe('{"changes":[]}');
  });
  it("strips ```json fences", () => {
    expect(extractChangesetJson('```json\n{"changes":[]}\n```')).toBe('{"changes":[]}');
  });
  it("pulls the object out of surrounding prose", () => {
    expect(extractChangesetJson('Sure! Here you go:\n{"changes":[{"op":"x"}]}\nHope that helps'))
      .toBe('{"changes":[{"op":"x"}]}');
  });
  it("returns null when there is no object", () => {
    expect(extractChangesetJson("no json here")).toBeNull();
  });
});

describe("hashSchema", () => {
  const a = [{ name: "T", columns: [{ name: "c", type: "Text" }] }] as any;
  const b = [{ name: "T", columns: [{ name: "c", type: "Number" }] }] as any;
  it("is stable for the same input", () => {
    expect(hashSchema(a)).toBe(hashSchema(a));
  });
  it("changes when a column type changes", () => {
    expect(hashSchema(a)).not.toBe(hashSchema(b));
  });
});

describe("decideTurn", () => {
  it("first turn: not already primed, schema counts as changed", () => {
    const r = decideTurn(null, "h1", 1);
    expect(r.primed).toBe(false);
    expect(r.schemaChanged).toBe(true);
    expect(r.next).toEqual({ primed: true, schemaHash: "h1", tabId: 1 });
  });
  it("second turn, same tab, same schema: primed, no schema change", () => {
    const r = decideTurn({ primed: true, schemaHash: "h1", tabId: 1 }, "h1", 1);
    expect(r.primed).toBe(true);
    expect(r.schemaChanged).toBe(false);
  });
  it("second turn, same tab, changed schema: primed, schema changed", () => {
    const r = decideTurn({ primed: true, schemaHash: "h1", tabId: 1 }, "h2", 1);
    expect(r.primed).toBe(true);
    expect(r.schemaChanged).toBe(true);
    expect(r.next.schemaHash).toBe("h2");
  });
  it("same schema but a different tab id: not primed (spec must be re-sent)", () => {
    const r = decideTurn({ primed: true, schemaHash: "h1", tabId: 1 }, "h1", 2);
    expect(r.primed).toBe(false);
    expect(r.next).toEqual({ primed: true, schemaHash: "h1", tabId: 2 });
  });
});

describe("buildSessionMessage", () => {
  const base = { skillName: "appsheet-architect", system: "SPEC+RULES", prompt: "add a bot", schemaText: "SCHEMA", needsSchema: true };
  it("primer, first turn: injects the full spec + schema + prompt", () => {
    const m = buildSessionMessage({ ...base, skillSource: "primer", alreadyPrimed: false, schemaChanged: true });
    expect(m).toContain("SPEC+RULES");
    expect(m).toContain("SCHEMA");
    expect(m).toContain("add a bot");
    expect(m).not.toContain("/appsheet-architect"); // primer never slashes
  });
  it("primer, later turn, unchanged schema: no spec, no schema, just the prompt", () => {
    const m = buildSessionMessage({ ...base, skillSource: "primer", alreadyPrimed: true, schemaChanged: false });
    expect(m).not.toContain("SPEC+RULES");
    expect(m).not.toContain("SCHEMA");
    expect(m).toBe("add a bot");
  });
  it("account mode: slash-commands the skill, never injects the spec", () => {
    const m = buildSessionMessage({ ...base, skillSource: "account", alreadyPrimed: false, schemaChanged: true });
    expect(m).toContain("/appsheet-architect add a bot");
    expect(m).not.toContain("SPEC+RULES");
    expect(m).toContain("SCHEMA");
  });
  it("account mode, unchanged schema: just the slash trigger + prompt", () => {
    const m = buildSessionMessage({ ...base, skillSource: "account", alreadyPrimed: true, schemaChanged: false });
    expect(m).not.toContain("SPEC+RULES");
    expect(m).not.toContain("SCHEMA");
    expect(m).toBe("/appsheet-architect add a bot");
  });
  it("needsSchema false: never includes schema even when changed (e.g. Ask AI)", () => {
    const m = buildSessionMessage({ ...base, skillSource: "account", needsSchema: false, alreadyPrimed: true, schemaChanged: true });
    expect(m).not.toContain("SCHEMA");
    expect(m).toBe("/appsheet-architect add a bot");
  });
});
