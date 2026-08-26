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

/** True while a response is streaming (a Stop button is present).
 *  Uses a broad aria-label match since the exact label varies by claude.ai version. */
function isStreaming(): boolean {
  return !!document.querySelector('button[aria-label*="Stop" i], button[aria-label*="stop" i]');
}

/** Text of the last assistant message block.
 *  Confirmed selectors via live DOM probe (2026-08-26):
 *  - Assistant turn container: class contains "msg-assistant-pb"
 *  - Response body paragraphs: class contains "font-claude-response-body"  */
function lastAssistantText(): string {
  const containers = Array.from(document.querySelectorAll<HTMLElement>('[class*="msg-assistant-pb"]'));
  if (containers.length) {
    const last = containers[containers.length - 1];
    const bodyEls = Array.from(last.querySelectorAll<HTMLElement>('[class*="font-claude-response-body"]'));
    if (bodyEls.length) {
      return bodyEls.map((el) => el.innerText || el.textContent || "").join("\n").trim();
    }
    // Fallback: strip the "Claude responded:" header from the container's full text.
    return (last.innerText || last.textContent || "").replace(/^Claude responded:\s*/i, "").trim();
  }
  // Final fallback: collect all response-body paragraphs on the page.
  const bodyEls = Array.from(document.querySelectorAll<HTMLElement>('[class*="font-claude-response-body"]'));
  return bodyEls.map((el) => el.innerText || el.textContent || "").join("\n").trim();
}

async function drive(
  text: string,
  expectJson = true,
  streamId?: string,
): Promise<{ json: string } | { text: string } | { error: string } | { needsLogin: true }> {
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

  // Push the accumulating reply to the sidebar as it streams (Ask AI tab).
  const pushStream = () => {
    if (!streamId) return;
    const partial = lastAssistantText();
    if (partial) browser.runtime.sendMessage({ __hoc: "claude-stream", streamId, text: partial }).catch(() => {});
  };

  // Wait for streaming to start (up to 8s), then for it to finish (up to 180s).
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !isStreaming()) await sleep(150);
  const t1 = Date.now();
  while (Date.now() - t1 < 180000 && isStreaming()) { pushStream(); await sleep(300); }
  if (isStreaming()) return { error: "claude.ai response timed out." };
  await sleep(400); // let the final chunk settle
  pushStream(); // final flush

  const reply = lastAssistantText();
  // Non-JSON tools (Formula/Explain/Fix/Ask/Types) want the raw reply text.
  if (!expectJson) return { text: reply };
  const json = extractChangesetJson(reply);
  if (!json) return { error: "No changeset JSON found in the reply." };
  return { json };
}

if (globalThis.chrome?.runtime?.id) {
  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as { __hoc?: string; text?: string; expectJson?: boolean; streamId?: string } | undefined;
    if (msg?.__hoc === "claude-status") return Promise.resolve({ signedIn: !needsLogin() && !!composer() });
    if (msg?.__hoc !== "claude-drive" || typeof msg.text !== "string") return undefined;
    return drive(msg.text, msg.expectJson !== false, msg.streamId);
  });
}
