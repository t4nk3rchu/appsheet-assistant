import { callBridge } from "./bridge-client";
import { makeBackup } from "./backup";
import { saveBackup } from "./storage";
import type { Table } from "./tables";
import type { Change, FillResult } from "./changeset";
export type { Table, Column } from "./tables";

export interface AppSchema {
  appId: string | null;
  appName: string | null;
  appTemplate: any;
}

export async function getSchema(): Promise<AppSchema> {
  const [appId, appName, appTemplate] = await Promise.all([
    callBridge<string | null>("getAppId"),
    callBridge<string | null>("getAppName"),
    callBridge<any>("getAppTemplate"),
  ]);
  return { appId, appName, appTemplate };
}

export async function getTables(): Promise<Table[]> {
  return (await callBridge<Table[]>("getTables")) ?? [];
}

export function editorReady(): Promise<boolean> {
  return callBridge<boolean>("editorReady").then((v) => !!v).catch(() => false);
}

/** Back up the current schema, then drive the editor to apply the changes.
 *  getSchema() returns a structured-clone snapshot (independent of the page's
 *  live object), so the backup captures the pre-change state the moment it's
 *  fetched. The storage WRITE (which reads+rewrites up to N prior backups, a few
 *  MB) is therefore safe to run in the BACKGROUND — awaiting it here previously
 *  blocked every Apply for many seconds. We await the cheap snapshot fetch, then
 *  fire-and-forget the save, then apply immediately. */
export async function applyChangeset(changes: Change[], now: number): Promise<FillResult[]> {
  const schema = await getSchema(); // pre-change snapshot (clone) — safety contract
  void saveBackup(makeBackup(schema, now)).catch(() => {}); // persist in the background
  return (await callBridge<FillResult[]>("applyChanges", { changes })) ?? [];
}

/** Set column types in the editor's columns grid (Đặt Type apply). */
export function applyTypes(table: string, cols: { column: string; type: string }[]) {
  return callBridge<{ applied: number; skipped: number; failed: number; details: { column: string; status: string }[] }>(
    "applyTypes",
    { table, cols },
  );
}
