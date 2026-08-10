// tests/skills.test.ts — the .skill/.md parser + prompt renderer.
import { describe, it, expect } from "vitest";
import { parseSkill, renderSkillsForPrompt, parseSkillZip } from "../src/lib/skills";
import { zipSync, strToU8 } from "fflate";

describe("parseSkillZip", () => {
  it("reads SKILL.md frontmatter + appends other .md files (fflate)", async () => {
    const zip = zipSync({
      "SKILL.md": strToU8("---\nname: my-skill\ndescription: does things\n---\nBody here"),
      "references/extra.md": strToU8("Extra content"),
      "assets/logo.png": strToU8("not markdown"),
    });
    const sk = await parseSkillZip("pkg.zip", zip.buffer as ArrayBuffer);
    expect(sk.name).toBe("my-skill");
    expect(sk.description).toBe("does things");
    expect(sk.body).toContain("Body here");
    expect(sk.body).toContain("references/extra.md");
    expect(sk.body).toContain("Extra content");
    expect(sk.body).not.toContain("not markdown"); // non-md skipped
  });
});

describe("parseSkill", () => {
  it("reads name/description from frontmatter and keeps the body", () => {
    const sk = parseSkill("ignored.md", `---\nname: grouped-action-pattern\ndescription: How to build add→edit→delete workflows\n---\nStep 1: create the child actions first.`);
    expect(sk.name).toBe("grouped-action-pattern");
    expect(sk.description).toBe("How to build add→edit→delete workflows");
    expect(sk.body).toBe("Step 1: create the child actions first.");
  });

  it("falls back to filename + first real line when no frontmatter", () => {
    const sk = parseSkill("My Skill.skill", `# Heading\n\nUse this for pricing rules.`);
    expect(sk.name).toBe("My Skill");
    expect(sk.description).toBe("Use this for pricing rules.");
    expect(sk.body).toContain("pricing rules");
  });

  it("folds a YAML block-scalar description (>-) across indented lines", () => {
    const sk = parseSkill("SKILL.md", `---\nname: appsheet-architect\ndescription: >-\n  Design, build, audit AppSheet apps.\n  Use for slow sync, virtual columns, security filters.\nmetadata:\n  x: y\n---\nBody here.`);
    expect(sk.name).toBe("appsheet-architect");
    expect(sk.description).toBe("Design, build, audit AppSheet apps. Use for slow sync, virtual columns, security filters.");
    expect(sk.body).toBe("Body here.");
  });

  it("strips quotes around frontmatter values", () => {
    const sk = parseSkill("x.md", `---\nname: "quoted"\ndescription: 'single'\n---\nbody`);
    expect(sk.name).toBe("quoted");
    expect(sk.description).toBe("single");
  });
});

describe("renderSkillsForPrompt", () => {
  it("returns empty string for no usable skills", () => {
    expect(renderSkillsForPrompt([])).toBe("");
    expect(renderSkillsForPrompt([{ name: "x", description: "d", body: "  " }])).toBe("");
  });

  it("lists each skill with its when-to-use and body", () => {
    const out = renderSkillsForPrompt([{ name: "s1", description: "when X", body: "do Y" }]);
    expect(out).toContain("### Skill: s1");
    expect(out).toContain("When to use: when X");
    expect(out).toContain("do Y");
  });
});
