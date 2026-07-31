import type { AppSchema } from "./appsheet";

export interface Issue {
  level: "error" | "warn";
  message: string;
}

export function validateSchema(schema: AppSchema): Issue[] {
  const issues: Issue[] = [];
  if (!schema.appId || !schema.appTemplate) {
    issues.push({
      level: "error",
      message: "No AppSheet app detected in this tab",
    });
    return issues;
  }
  const tables = schema.appTemplate.tables ?? [];
  for (const t of tables) {
    if (!t.columns || t.columns.length === 0) {
      issues.push({
        level: "warn",
        message: `Table "${t.name}" has no columns`,
      });
    }
  }
  return issues;
}
