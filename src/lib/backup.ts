import type { AppSchema } from "./appsheet";

export interface Backup {
  id: string;
  createdAt: number;
  appId: string | null;
  appName: string | null;
  appTemplate: unknown;
}

export function makeBackup(schema: AppSchema, now: number): Backup {
  return {
    id: `backup_${now}`,
    createdAt: now,
    appId: schema.appId,
    appName: schema.appName,
    appTemplate: schema.appTemplate,
  };
}
