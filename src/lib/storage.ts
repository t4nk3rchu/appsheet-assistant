import browser from "webextension-polyfill";
import type { Backup } from "./backup";
import type { Skill } from "./skills";

export interface Settings {
  provider: "gemini" | "deepseek";
  apiKeys: Record<string, string>;
  baseUrls: Record<string, string>;
  darkMode: boolean;
  lang: "vi" | "en";
  // Persistent app conventions / guidance the AI reads before every Build App
  // generation (naming rules, preferred patterns, house style, …).
  buildInstructions: string;
}

const DEFAULTS: Settings = { provider: "gemini", apiKeys: {}, baseUrls: {}, darkMode: false, lang: "vi", buildInstructions: "" };
const S_KEY = "settings";
const B_KEY = "backups";
const SK_KEY = "skills";

export async function getSettings(): Promise<Settings> {
  const got = (await browser.storage.local.get(S_KEY)) as any;
  return { ...DEFAULTS, ...(got[S_KEY] ?? {}) };
}
export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ [S_KEY]: next });
}
export async function listBackups(): Promise<Backup[]> {
  const got = (await browser.storage.local.get(B_KEY)) as any;
  return got[B_KEY] ?? [];
}
export async function saveBackup(b: Backup): Promise<void> {
  const all = await listBackups();
  await browser.storage.local.set({ [B_KEY]: [b, ...all].slice(0, 20) }); // ponytail: cap at 20 backups
}
export async function getSkills(): Promise<Skill[]> {
  const got = (await browser.storage.local.get(SK_KEY)) as any;
  return got[SK_KEY] ?? [];
}
export async function saveSkills(skills: Skill[]): Promise<void> {
  await browser.storage.local.set({ [SK_KEY]: skills });
}
