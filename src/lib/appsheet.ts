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

/** Back up the current schema, then drive the editor to apply the changes. */
export async function applyChangeset(changes: Change[], now: number): Promise<FillResult[]> {
  const schema = await getSchema();
  await saveBackup(makeBackup(schema, now)); // safety contract: backup before any write
  return (await callBridge<FillResult[]>("applyChanges", { changes })) ?? [];
}

/** Set column types in the editor's columns grid (Đặt Type apply). */
export function applyTypes(table: string, cols: { column: string; type: string }[]) {
  return callBridge<{ applied: number; skipped: number; failed: number; details: { column: string; status: string }[] }>(
    "applyTypes",
    { table, cols },
  );
}
