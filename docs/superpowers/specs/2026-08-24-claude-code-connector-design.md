# Claude (claude.ai) connector — design (v1)

## Goal

Let the AppSheet Assistant extension generate changesets using the user's
**claude.ai** subscription (its model + skills + accumulated context) instead of
the extension's BYOK API providers — entirely in-browser, no local process, no
MCP server. One direction only:

**Extension → claude.ai → changeset back.** The user types a request in the
extension; the extension drives the user's logged-in claude.ai chat to generate
a JSON changeset, brings it back into the Changeset box, and the user reviews +
Applies.

Non-goals (explicitly dropped from the earlier bridge/MCP design):
- **No** "Claude controls the extension" direction → **no MCP server** to deploy
  or manage.
- **No** local bridge process.
- **No** API keys / API-token cost → uses the claude.ai subscription session.

The claude.ai path is **additive**; the existing Gemini/DeepSeek BYOK path is
unchanged, and if claude.ai isn't reachable the extension behaves as today.

## Decisions (locked in brainstorming)

- Reach Claude by **reusing the logged-in claude.ai session** (DOM automation of
  a browser tab), not the Anthropic API and not the desktop CLI.
- Surface = **plain claude.ai chat** (not claude.ai/code).
- Tab strategy = **extension-managed dedicated claude.ai tab**, **one persistent
  conversation** managed in the chat session itself (context accumulates; current
  schema re-fed when it changes). **No claude.ai Project** — plain chat only.
- Skill delivery = **user setting, 2 modes** (below); primer is the default.
- **Human-in-loop Apply** preserved: claude.ai only produces JSON into the box;
  the user still clicks Apply, then Save in AppSheet.

## Architecture

```
AppSheet tab (sidebar)  ──runtime msg──►  background relay  ──►  claude.ai tab (claude-driver content script)
   user ask + schema                       manages tab +          inject prompt → wait → extract JSON
        ◄─────────────────  changeset JSON  ◄──────────────────────────────
   box → validate → plan → Apply → (user Saves in AppSheet)
```

All in-browser, within the extension's existing DOM-automation paradigm (it
already drives one site — AppSheet; this adds a second driver — claude.ai). No
new process.

### Components

**1. `src/content/claude-driver.ts`** (new content script, matches
`https://claude.ai/*`):
- Locate the composer (ProseMirror `contenteditable`), set text, submit.
- Detect response completion (streaming stop → copy/retry controls appear).
- Extract the latest assistant message text → parse the JSON changeset.
- Manage the conversation: start a new chat or continue the managed one; report
  login/usage-cap states.

**2. Background relay** (additions to `src/background/index.ts`):
- Open / focus / track one **managed claude.ai tab** (store its `tabId`).
- Route messages between the AppSheet sidebar and the claude.ai driver.
- Hold conversation state: `primed?`, last `schemaHash`, in-flight guard.

**3. Sidebar** (Build tab, additions):
- "Ask Claude (claude.ai)" action beside the existing Generate.
- Status line: claude.ai tab present / logged in / conversation ready / generating.
- Settings: **Skill source** (see below) + configurable skill name.
- Inbound changeset → existing Changeset box → existing validate → plan → **Apply**
  (engine + human gate + Save unchanged).

**4. Prompt building** — reuse `changesetPrompt` (`src/lib/prompts.ts`) for the
schema + ask + rules. Framing adapts to the skill-source mode.

## Skill delivery — user setting (2 modes)

The extension cannot reliably detect what's configured in the user's claude.ai
account, so **Skill source** is an explicit setting. Default = primer. No
claude.ai Project is involved — everything runs in a plain chat conversation.

1. **Account skill** — the user has uploaded `appsheet-architect` via claude.ai
   Customize. Extension frames each ask as `"Use the appsheet-architect skill to:
   {ask}"` + schema. No primer. (Skill name is configurable.)
2. **Inject primer** (default) — on conversation start the extension sends the
   changeset spec + any selected Skills-box entries as the first message (reusing
   the existing skills-injection mechanism), then ask + schema. Self-contained,
   zero claude.ai setup.

Schema is fed on the first turn and re-fed whenever it changes (hash-compare), in
both modes — accuracy never depends on chat history.

## Data flow

```
1. Sidebar: user types ask → "Ask Claude (claude.ai)"
2. Sidebar → background: {ask, schema, schemaHash}
3. Background: ensure managed claude.ai tab (open/focus); ensure conversation
   primed per Skill-source mode
4. Background → claude-driver: {mode, primer?(first/changed), schema?(changed), ask}
5. Driver: inject into composer → submit → wait for completion → extract JSON
6. Driver → background → sidebar: {type:"changeset", json}  (or {error|needsLogin|usageCap})
7. Sidebar: JSON → box → validate → plan view
8. User clicks Apply → autofill engine → user Saves in AppSheet
```

Single in-flight request at a time (queue/reject concurrent asks).

## Error handling & edge cases

| Situation | Behavior |
|-----------|----------|
| claude.ai not logged in | Driver detects login screen → sidebar: "Log into claude.ai." BYOK path still works. |
| Managed tab closed | Background reopens + re-primes on next ask. |
| Conversation cleared / lost | Re-prime (re-send primer + schema) automatically. |
| Reply isn't valid JSON | Existing validator shows errors in the plan; nothing applies. v1: user re-asks (auto round-trip = later). |
| Usage cap / rate limit on claude.ai | Driver surfaces claude.ai's message → sidebar tells the user; suggests BYOK fallback. |
| Streaming never completes | Timeout after N seconds → error surfaced. |
| claude.ai DOM changed | Driver selectors break → error surfaced; fix selectors (same maintenance model as the AppSheet driver). |
| No AppSheet editor / schema unavailable | `editorReady()` false → sidebar blocks the ask with a message. |
| Concurrent asks | One in-flight; extra asks queued or rejected with "busy." |

Through-line: **additive and fail-safe** — any failure degrades to today's
behavior; claude.ai output only ever lands in the box behind the human Apply gate.

## Security & privacy

- **New host permission** `https://claude.ai/*` (content script + relay). AMO
  disclosure extended: app structure is optionally sent to the user's own
  claude.ai session.
- **No API key** stored; relies on the user's existing claude.ai login (their
  account, their session).
- **Data sent to claude.ai** = app schema (table/column names — structure, not
  row data; same class as the BYOK providers already receive) + the user's ask +
  the returned changeset JSON.
- **ToS note / primary risk** — automating claude.ai (even one's own logged-in
  session) is less clearly sanctioned than automating AppSheet (the product the
  extension targets). This is the main risk alongside DOM fragility. Mitigations:
  it's the user's own account and data, one managed tab, no scraping of other
  users' content, human-gated output. Documented as a known caveat.

## Scope

**In v1:**
- `claude-driver.ts`: composer inject, completion detection, JSON extraction,
  conversation management (new/continue), login/usage-cap detection.
- Background relay + managed-tab lifecycle + conversation state.
- Sidebar "Ask Claude" action, status, Skill-source setting (+ skill name),
  box/validate/plan/Apply reuse.
- 2-mode skill delivery; persistent conversation; schema-on-change.

**Out (later):**
- Live streaming of Claude's thinking into the sidebar (v1 shows "generating…").
- Auto-fixing an invalid changeset via a follow-up turn.
- claude.ai/code (agentic) surface.
- Auto-detecting account skills.

## Testing

- **claude-driver** — pull the testable logic into pure functions: JSON
  extraction from message text (fenced / prose-wrapped / clean) and
  completion-state detection, unit-tested with DOM/text fixtures. Full DOM drive
  is manual (codebase convention — same as the AppSheet engine).
- **Background relay** — message routing + managed-tab state (open/reopen,
  primed/schemaHash) unit-tested with mocked `browser.tabs`/messaging.
- **Prompt framing** — unit-test that each Skill-source mode produces the right
  prompt shape (account-skill prefix vs. primer = spec first turn; schema re-fed
  on hash change).
- **E2E (manual)** — happy path both a fresh and a warmed conversation;
  not-logged-in; tab-closed reopen; invalid-JSON; usage-cap; concurrent-ask
  guard.

## Open items to resolve at implementation

- claude.ai composer + "response complete" + message-extraction selectors
  (probe live; expect iteration, like the AppSheet driver).
- How the driver starts a **new** conversation vs. continues the managed one
  (URL nav vs. in-page "new chat" control), and how it re-locates the managed
  conversation after a tab reopen (store the conversation URL/id).
- Exact detection of the usage-cap / login-required states.
- Whether the sidebar shows a compact live status from the driver ("thinking…"
  vs. just a spinner) in v1.
