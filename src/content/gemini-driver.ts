// src/content/gemini-driver.ts — ISOLATED-world content script on
// gemini.google.com. Drives one Gem conversation: inject a message, wait for the
// reply to finish streaming, and return the reply text. Selectors verified live
// (2026-08-26): composer .ql-editor, Send/Stop by aria-label, reply .markdown-main-panel.
import browser from "webextension-polyfill";
import { extractChangesetJson } from "../lib/claude-msg";

declare global {
  var chrome: { runtime?: { id?: string } } | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The prompt composer (Quill contenteditable). */
function composer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.ql-editor[contenteditable="true"]');
}

/** True when we appear to be on a login screen (no composer + a sign-in link). */
function needsLogin(): boolean {
  if (composer()) return false;
  return /\/(signin|accounts)/.test(location.pathname) ||
    !!document.querySelector('a[href*="accounts.google.com"], a[href*="/signin"]');
}

/** Set the composer text. Quill blocks innerHTML (Trusted Types CSP), so use
 *  execCommand("insertText") after selecting the existing content. */
function setComposer(el: HTMLElement, text: string): void {
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand("insertText", false, text);
}

/** The Send button. */
function sendButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
}

/** True while a response is streaming (a Stop button is present). */
function isStreaming(): boolean {
  return !!document.querySelector('button[aria-label*="Stop" i]');
}

/** Text of the last assistant response block (last .markdown-main-panel). */
function lastAssistantText(): string {
  const panels = Array.from(document.querySelectorAll<HTMLElement>(".markdown-main-panel"));
  if (!panels.length) return "";
  const last = panels[panels.length - 1];
  return (last.innerText || last.textContent || "").trim();
}

async function drive(
  text: string,
  expectJson = true,
  streamId?: string,
): Promise<{ json: string } | { text: string } | { error: string } | { needsLogin: true }> {
  if (needsLogin()) return { needsLogin: true };
  const el = composer();
  if (!el) return { error: "Gemini composer not found (open the Gem)." };

  const before = document.querySelectorAll(".markdown-main-panel").length;
  setComposer(el, text);
  await sleep(150);
  const btn = sendButton();
  if (btn && !btn.disabled) {
    btn.click();
  } else {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }

  const pushStream = () => {
    if (!streamId) return;
    const partial = lastAssistantText();
    if (partial) browser.runtime.sendMessage({ __hoc: "gemini-stream", streamId, text: partial }).catch(() => {});
  };

  // Wait for a new response block to appear + streaming to start (up to 8s),
  // then for streaming to finish (up to 180s).
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 &&
    !isStreaming() &&
    document.querySelectorAll(".markdown-main-panel").length <= before) await sleep(150);
  const t1 = Date.now();
  while (Date.now() - t1 < 180000 && isStreaming()) { pushStream(); await sleep(300); }
  if (isStreaming()) return { error: "Gemini response timed out." };
  await sleep(400); // let the final chunk settle
  pushStream();

  const reply = lastAssistantText();
  if (!expectJson) return { text: reply };
  const json = extractChangesetJson(reply);
  if (!json) return { error: "No changeset JSON found in the reply." };
  return { json };
}

if (globalThis.chrome?.runtime?.id) {
  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as { __hoc?: string; text?: string; expectJson?: boolean; streamId?: string } | undefined;
    if (msg?.__hoc === "gemini-status") return Promise.resolve({ signedIn: !needsLogin() && !!composer() });
    if (msg?.__hoc !== "gemini-drive" || typeof msg.text !== "string") return undefined;
    return drive(msg.text, msg.expectJson !== false, msg.streamId);
  });
}
