// src/content/claude-driver.ts — ISOLATED-world content script on claude.ai.
// Drives one chat conversation: inject a message, wait for the reply to finish
// streaming, and return the extracted changeset JSON. Selectors are verified
// live (see the connector plan, Task 7).
import browser from "webextension-polyfill";
import { extractChangesetJson } from "../lib/claude-msg";

declare global {
  var chrome: { runtime?: { id?: string } } | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The chat composer (ProseMirror contenteditable). */
function composer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('div[contenteditable="true"].ProseMirror, div.ProseMirror[contenteditable="true"]');
}

/** True when we appear to be on a login screen (no composer + a login control). */
function needsLogin(): boolean {
  if (composer()) return false;
  return /\/login|\/onboarding/.test(location.pathname) ||
    !!document.querySelector('a[href*="/login"], button[data-testid="login"]');
}

/** Set the composer text (ProseMirror needs an input event, not just .textContent). */
function setComposer(el: HTMLElement, text: string): void {
  el.focus();
  // Replace content: select-all + insertText via execCommand is the most
  // ProseMirror-friendly path in a content script.
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand("insertText", false, text);
}

/** The Send button. */
function sendButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[aria-label="Send message"], button[aria-label="Send Message"]');
}

/** True while a response is streaming (a Stop button is present). */
function isStreaming(): boolean {
  return !!document.querySelector('button[aria-label="Stop response"], button[aria-label="Stop generating"]');
}

/** Text of the last assistant message block. */
function lastAssistantText(): string {
  const msgs = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="assistant-message"], div.font-claude-message'));
  const last = msgs[msgs.length - 1];
  return last ? (last.innerText || last.textContent || "") : "";
}

async function drive(text: string): Promise<{ json: string } | { error: string } | { needsLogin: true }> {
  if (needsLogin()) return { needsLogin: true };
  const el = composer();
  if (!el) return { error: "claude.ai composer not found (open a chat)." };

  setComposer(el, text);
  await sleep(150);
  const btn = sendButton();
  if (btn && !btn.disabled) {
    btn.click();
  } else {
    // Fallback: Enter submits in the ProseMirror composer.
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }

  // Wait for streaming to start (up to 8s), then for it to finish (up to 180s).
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !isStreaming()) await sleep(150);
  const t1 = Date.now();
  while (Date.now() - t1 < 180000 && isStreaming()) await sleep(300);
  if (isStreaming()) return { error: "claude.ai response timed out." };
  await sleep(400); // let the final chunk settle

  const reply = lastAssistantText();
  const json = extractChangesetJson(reply);
  if (!json) return { error: "No changeset JSON found in the reply." };
  return { json };
}

if (globalThis.chrome?.runtime?.id) {
  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as { __hoc?: string; text?: string } | undefined;
    if (msg?.__hoc !== "claude-drive" || typeof msg.text !== "string") return undefined;
    return drive(msg.text);
  });
}
