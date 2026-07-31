// src/lib/messaging.ts
export const REQ_TAG = "__hoc_appsheet_request";
export const RES_TAG = "__hoc_appsheet_response";

export type BridgeAction =
  | "ping"
  | "getAppTemplate"
  | "getAppId"
  | "getAppName"
  | "getTables"
  | "editorReady"
  | "setFormatColumns"
  | "applyChanges"
  | "applyTypes";

let counter = 0;

export function sendToBridge<T = unknown>(action: BridgeAction, payload?: unknown): Promise<T> {
  const id = `${Date.now()}_${counter++}`;
  return new Promise<T>((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window) return;
      const d: any = e.data;
      if (!d || d.__tag !== RES_TAG || d.id !== id) return;
      window.removeEventListener("message", onMsg);
      if ("error" in d && d.error) reject(new Error(d.error));
      else resolve(d.result as T);
    };
    window.addEventListener("message", onMsg);
    window.postMessage({ __tag: REQ_TAG, id, action, payload }, "*");
  });
}
