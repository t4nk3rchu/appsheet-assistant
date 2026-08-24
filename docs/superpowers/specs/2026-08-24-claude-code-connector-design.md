# Claude Code connector — design (v1)

## Goal

Let the AppSheet Assistant extension generate changesets **inside the user's
Claude Code** (its subscription tokens + accumulated context + the
`appsheet-architect` skill) instead of the extension's BYOK provider, over a
local bridge. Two directions, both in v1:

- **Extension-initiated** — type a request in the extension sidebar; a Claude
  Code session generates the JSON changeset and pushes it back into the
  extension for review + Apply.
- **CC-terminal-initiated** — from a Claude Code session, read the live AppSheet
  schema and push a changeset to the running extension.

Non-goal: replacing the existing Gemini/DeepSeek BYOK path. The Claude Code path
is **additive**; if the bridge is down the extension behaves exactly as today.

## Chosen shape (decisions locked in brainstorming)

- CC surface = **headless-capable but persistent session**: the user keeps one
  Claude Code session open running an `/appsheet-bridge` skill; generation runs
  in that session (not the desktop GUI, not per-request `claude -p`).
- **Both directions** in v1.
- **Human-in-loop Apply**: CC only *pushes* a changeset into the extension's
  Changeset box; the user still clicks Apply, then Save in AppSheet. The
  never-auto-save contract is preserved.
- Architecture = **WS hub + persistent CC session** (one Node bridge that is
  both a WebSocket server for the extension and an MCP server for CC).
- Extension→CC hand-off = **watch loop** in the skill (long-poll
  `appsheet_next_request`).
- Security = **paste-a-token pairing**.

## Architecture

```
┌─────────────────┐   WS (127.0.0.1, token+origin authed)   ┌──────────────┐   MCP (stdio)   ┌──────────────────┐
│  Extension      │◄───────────────────────────────────────►│   Bridge      │◄───────────────►│  Claude Code     │
│  (sidebar/bg)   │  prompt, schema, editorState,             │  (Node proc)  │  tools + result  │  session          │
│                 │  changeset, stream, apply-result          │  WS srv+MCP   │                  │  /appsheet-bridge │
└─────────────────┘                                           └──────────────┘                  └──────────────────┘
```

Three pieces, one new process. The extension stays fully sandboxed — its only
new capability is a WS client to loopback. The bridge is the sole process that
touches Claude Code. Generation always happens in CC.

### 1. Bridge (`bridge/` — standalone Node package, run via `npx appsheet-cc-bridge`)

- **WS server** on `127.0.0.1:<port>` — the extension connects here.
  Bidirectional, streams. Binds loopback only (never `0.0.0.0`).
- **MCP server** (stdio) — the Claude Code session connects here. Tools:
  - `appsheet_get_schema()` → live tables/columns (relayed from the extension)
  - `appsheet_get_editor_state()` → `{ appId, appName, openPane }`
  - `appsheet_push_changeset(json, note?)` → sends JSON to the extension's box
  - `appsheet_next_request()` → long-poll; returns a queued extension prompt
    `{ ask, schema, editorState }` (or times out empty)
  - `appsheet_report(text)` → relay status/thinking to the extension UI (stream)
- In-memory state only (no DB/persistence): the one paired extension socket, a
  request queue, the pairing token. Restart = reconnect + re-pair-from-file.

### 2. Extension (new bits)

- `src/lib/bridge-ws.ts` — WS client: connect, send token on every message,
  auto-reconnect, dedupe inbound by message `id`.
- "Connect to Claude Code" UI in the Build tab: token paste field, connection
  status (Disconnected / Paired / CC-session-watching), and an "Ask Claude Code"
  action next to the existing Generate.
- Inbound `changeset` message → drop JSON into the existing Changeset box →
  existing local validation → existing plan view → existing **Apply** (unchanged
  engine, unchanged human gate, unchanged Save-in-AppSheet).
- New CSP/permission: `connect-src ws://127.0.0.1:*` (or a fixed port).
- Additive: the `"claudecode"` path sits alongside Gemini/DeepSeek in settings;
  those still return a string via `AiProvider.complete()` as today.

### 3. CC-side skill (`/appsheet-bridge`)

Ships in the `appsheet-architect` repo (or a small sibling skill). Two modes off
the same MCP connection:
- **Watch loop** (extension-initiated): long-poll `appsheet_next_request()`; on a
  prompt, generate JSON against the returned live schema (changeset spec +
  appsheet-architect skill already in context), stream via `appsheet_report`,
  then `appsheet_push_changeset(json, note)`.
- **Ad-hoc** (CC-initiated): the user just says "add a bot that…"; the skill
  calls `appsheet_get_schema` / `appsheet_get_editor_state`, generates, and
  `appsheet_push_changeset`.

## Data flow

Envelope on the WS: `{ id, type, payload }`.

**Direction B — extension-initiated:**
```
1. Sidebar: user types ask → "Ask Claude Code"
2. Extension → bridge:  {type:"prompt", ask, schema, editorState}
                        (schema = getTables(); editorState = appId/name/pane)
3. Bridge enqueues; CC loop calls appsheet_next_request() → {ask, schema, editorState}
4. CC generates JSON (its context + appsheet-architect skill + changeset spec)
5. (optional) CC appsheet_report(text) → bridge → {type:"stream", delta} → sidebar
6. CC appsheet_push_changeset(json, note)
7. Bridge → extension:  {type:"changeset", json, note}
8. Extension: JSON → box → validate → plan view
9. User clicks Apply → autofill engine → user Saves in AppSheet
```

**Direction A — CC-terminal-initiated:**
```
1. CC session: "add a bot that emails on overdue rows"
2. CC appsheet_get_schema() / appsheet_get_editor_state() → bridge → extension → live schema
3. CC generates JSON → appsheet_push_changeset(json)
4. Bridge → extension → box + plan
5. User clicks Apply → Save
```

Both directions converge at "push_changeset → box → Apply": same validation,
same plan, same human gate. The extension doesn't care which side started it.
Schema is always pulled **live from the extension**, so CC generates against the
real current app (names validated before Apply, as today).

## Security & pairing

- **Pairing token.** On first launch the bridge prints a token and writes
  `~/.appsheet-bridge/token`. The user pastes it into the extension once; stored
  in `browser.storage.local`, sent on every WS message. Unpaired sockets
  rejected. (Same pattern as Vite/Metro localhost dev servers.)
- **Origin allowlist.** WS server checks `Origin` — accepts only
  `moz-extension://…` / `chrome-extension://…`; rejects `http(s)://` page
  origins outright.
- **Loopback only.** Bind `127.0.0.1`; not reachable off-machine.
- **CC ⇄ bridge = stdio MCP.** No network surface; a child process the user
  launched.
- **Single extension socket.** One paired connection; a second is rejected (or
  replaces, with a log).
- **No secrets cross the bridge.** No API keys (CC uses its own auth). Only app
  schema (structure, not row data — same exposure BYOK providers already get) +
  changeset JSON + the user's prompt.
- **AMO disclosure.** Extend the existing "AI transmits app structure" listing
  note to cover "optionally a local Claude Code bridge."

## Error handling & edge cases

| Situation | Behavior |
|-----------|----------|
| Bridge not running / not paired | "Ask Claude Code" shows **Not connected**; BYOK path still works. No hard dependency. |
| No CC session watching | Prompt queues; ~30s timeout → sidebar: "No Claude Code session connected — start `/appsheet-bridge`." |
| CC returns invalid JSON | Existing validator catches it → errors in plan view; nothing applies. v1: user re-asks (auto round-trip = later). |
| No AppSheet editor tab / not ready | `editorReady()` false → bridge returns error to CC's tool call → "no live app open." |
| Multiple AppSheet tabs | `editorState.appId` targets the active/last-focused editor tab. v1 limitation; picker later. |
| WS drops mid-request | Auto-reconnect; message `id` dedupes a re-pushed changeset (no double-fill). |
| Bad pushed changeset | Apply is still a human click, Save still manual — worst case is a changeset you don't Apply. |

Through-line: the connector is **fail-safe and additive** — any part down and
the extension degrades to exactly today's behavior. The CC path can never
auto-mutate the app.

## Scope

**In v1:**
- Bridge: WS server + MCP server, pairing token, message router, the five MCP
  tools, request queue.
- Extension: `bridge-ws.ts` client, Connect/Ask-Claude-Code UI, inbound
  changeset → box/validate/plan/Apply reuse, `connect-src` permission.
- Skill `/appsheet-bridge`: watch loop + ad-hoc, generate against live schema.
- Both directions, human-in-loop Apply, pairing security.

**Out (later):**
- Live token-streaming deltas (`appsheet_report` wired, but v1 sidebar may just
  show "generating…").
- CC auto-fixing an invalid changeset via round-trip.
- Multi-tab picker.
- Anything beyond the current changeset engine (e.g. `set_bot`).

## Testing

- **Bridge** — `node:test`: message router, pairing accept/reject, origin
  allowlist, queue hand-off (`prompt` enqueue → `next_request` dequeue). No
  browser.
- **Extension** — `bridge-ws` client against a mock WS: connect, token on every
  message, reconnect, dedupe-by-`id`. Changeset receipt reuses the
  already-tested `changeset.ts` validator.
- **E2E (manual, VisiconDemo via zen-mcp)** — both directions; invalid-JSON
  path; bridge-down degrade; no-session timeout; multi-tab targeting.

## Open items to resolve at implementation

- Fixed port vs. discovered port (a fixed default keeps the `connect-src` CSP
  tight; make it overridable).
- MCP transport detail: stdio (bridge launched as an MCP server in CC's config)
  vs. the bridge launched standalone with CC connecting — confirm against the
  current Claude Code MCP-server registration flow.
- Exact `appsheet_report` streaming envelope if we pull streaming into v1.
