// src/lib/skills.ts — user-uploaded "skills": a markdown file with optional
// YAML-ish frontmatter (name/description) + a body of guidance. The AI is shown
// each skill's name + "when to use" and applies the ones matching the request
// (auto-trigger by description). Pure module — no browser/storage deps, so the
// parser is unit-testable.

export interface Skill {
  name: string;
  description: string;
  body: string;
}

/** Parse a .skill/.md file into a Skill. Frontmatter form:
 *    ---
 *    name: my-skill
 *    description: when to use this
 *    ---
 *    <body>
 *  Without frontmatter: name = filename (no extension), description = first
 *  non-empty non-heading line, body = whole text. */
export function parseSkill(filename: string, text: string): Skill {
  const base = String(filename || "skill").replace(/\.[^.]+$/, "").trim() || "skill";
  let name = base;
  let description = "";
  let body = String(text ?? "").trim();

  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    body = body.slice(fm[0].length).trim();
    const lines = fm[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^([\w-]+)\s*:\s*(.*)$/);
      if (!m) continue; // continuation lines are consumed by the block-scalar branch below
      const key = m[1].toLowerCase();
      let val = m[2].trim();
      // YAML block scalar (>, >-, |, |-, >+ …) or empty value → the real value is
      // on the following more-indented lines. Fold "|" with newlines, ">" with spaces.
      if (val === "" || /^[|>][+-]?$/.test(val)) {
        const cont: string[] = [];
        while (i + 1 < lines.length && (lines[i + 1].trim() === "" || /^\s/.test(lines[i + 1]))) {
          cont.push(lines[++i].trim());
        }
        val = (val.startsWith("|") ? cont.join("\n") : cont.join(" ")).trim();
      } else {
        val = val.replace(/^["']|["']$/g, "");
      }
      if (key === "name" && val) name = val;
      else if (key === "description") description = val;
    }
  }
  if (!description) {
    description = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) || "";
  }
  return { name, description, body };
}

/** Max characters kept per skill body (a huge multi-file skill would otherwise
 *  blow the prompt/quota — every skill body is injected on each Build). */
const SKILL_BODY_CAP = 30000;

/** Parse a .zip skill package (Anthropic-style: SKILL.md + references/*.md) into
 *  a single Skill. name/description come from SKILL.md frontmatter; body =
 *  SKILL.md body followed by each other .md file under its own "# path" heading.
 *  Uses fflate (no eval — JSZip's Function() constructor tripped AMO review);
 *  kept out of parseSkill so the md parser stays dependency-free. */
export async function parseSkillZip(filename: string, data: ArrayBuffer): Promise<Skill> {
  const { unzipSync, strFromU8 } = await import("fflate");
  // unzipSync returns { path: Uint8Array } for files only (directory entries end
  // in "/"). Skill packages are a handful of small text files, so sync is fine.
  const files = unzipSync(new Uint8Array(data));
  const paths = Object.keys(files).filter((p) => !p.endsWith("/"));
  const read = (p: string) => strFromU8(files[p]);

  // shallowest SKILL.md wins (the package's entry point)
  const skillPath = paths
    .filter((p) => /(^|\/)SKILL\.md$/i.test(p))
    .sort((a, b) => a.split("/").length - b.split("/").length)[0];

  let name = String(filename || "skill").replace(/\.zip$/i, "").split("/").pop() || "skill";
  let description = "";
  const parts: string[] = [];
  if (skillPath) {
    const sk = parseSkill("SKILL.md", read(skillPath));
    name = sk.name;
    description = sk.description;
    if (sk.body) parts.push(sk.body);
  }
  const others = paths
    .filter((p) => p !== skillPath && /\.mdx?$/i.test(p))
    .sort((a, b) => a.localeCompare(b));
  for (const p of others) {
    parts.push(`\n---\n# ${p}\n${read(p).trim()}`);
  }
  let body = parts.join("\n").trim();
  if (body.length > SKILL_BODY_CAP) body = body.slice(0, SKILL_BODY_CAP) + "\n…(truncated)";
  return { name, description, body };
}

/** Render the enabled skills as a Build-prompt block. The AI applies only the
 *  skill(s) whose "when to use" matches the request. Empty list → "". */
export function renderSkillsForPrompt(skills: Skill[]): string {
  const usable = (skills || []).filter((s) => s && s.body && s.body.trim());
  if (!usable.length) return "";
  const blocks = usable.map((s) => `### Skill: ${s.name}\nWhen to use: ${s.description || "(no description)"}\n${s.body.trim()}`);
  return (
    `\n## Skills (user-provided). Read every skill's "When to use". APPLY only the skill(s) that fit this request; ignore the rest. When a skill applies, follow its guidance over the defaults.\n` +
    blocks.join("\n\n") +
    "\n"
  );
}
