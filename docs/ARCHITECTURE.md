# Architecture

For contributors. Users should start with the [README](../README.md) and [USAGE.md](USAGE.md).

The plugin lets Paseo chat with an agent that is already running in a Herdr terminal pane. It never owns the agent: it observes it through Herdr and the agent's own session file, and it controls it through a small companion loaded inside the agent.

```
Paseo daemon
 ├─ client bundle (index.client.tsx): Herdr screen, settings, composer pill, timeline row
 └─ server bundle (index.server.ts): provider "herdr-omp", management RPCs, hooks
        │  seam 2: Herdr socket (one JSON request per connection; events.subscribe stream)
        ▼
     Herdr ── pane ── omp process
        │                 │  seam 3: <tmpdir>/omp-input-<pid>/sock  (JSON line per request)
        │                 └─ input companion (harness-extension/omp.ts)
        └─ session file (JSONL) ◀── tailed by the server (FileTail)
```

## The three seams

| Seam | Direction | What crosses it | Code |
|---|---|---|---|
| 1. Paseo plugin API (`@getpaseo/plugin`) | Paseo ⇄ plugin | Provider protocol events, settings, RPCs, lifecycle hooks, client screens | `index.server.ts`, `index.client.tsx`, `server/provider.ts`, `server/rpc.ts`, `shared/rpc.ts` |
| 2. Herdr socket | server → Herdr | `ping`, `agent.list`, `agent.start`, `pane.list`, `pane.process_info`, `pane.send_keys`, `workspace.list` / `workspace.create`, `tab.list` / `tab.create`, `integration.list`, `events.subscribe` | `server/herdr/client.ts`, `server/herdr/schema.ts`, `server/herdr/target.ts`, `server/herdr/socket-path.ts` |
| 3. OMP input companion | server → OMP process | `inspect`, `submit`, `config`, `configure`, `approval.snapshot`, `approval.resolve`, `clearDraft` | `server/harness/omp/input.ts`, `harness-extension/omp.ts` |

Seam 2 is one fresh connection per request (5 s timeout; 15 s for `agent.prompt`), except `events.subscribe`, which reconnects with backoff and reports lost events. Seam 3 is also one connection per operation. Every request carries a fresh nonce, and every reply must echo the process id, native session reference and a per-process `instanceId`, so a prompt is never delivered to a replacement process. A write whose outcome is unclear is reported as `uncertain` and is never retried.

## Module map

### `plugin/server/`

| Module | Role |
|---|---|
| `provider.ts` | `createHerdrProvider(adapter, getSocketPath, hooks)`: one Paseo provider per harness (`herdr-<id>`). Handles `catalog`, `sessions` (import list), `session.open` (create, bind, reopen), `session.prompt`, `session.interrupt`, `session.permission`, `session.configure`, `session.close`, and provider `status()`. |
| `session.ts` | `HerdrHarnessSession`: one open chat. Owns `SessionState`, `create` / `bind` / `open`, `validateAgent`, `freeze`. |
| `live-session.ts` | `LiveSession`: the reconcile loop (2 s poll, Herdr event notifications, transcript tail), early-abort detection, deadline timers. |
| `turns.ts` | `TurnTracker`: pure turn lifecycle state machine. No I/O. |
| `prompt.ts` | `PromptController`: prompt admission and delivery, Stop. |
| `approvals.ts` | `ApprovalController`: pending approvals and questions to Paseo permission cards, decisions back, decision timeline rows. |
| `config.ts` | `ConfigController`, `ModelCache`: model and thinking level selection. |
| `forks.ts` | `ForkWatcher`: scans for sibling session files forked from the bound one. |
| `binding.ts` | `Binding` (what a chat is attached to), persistence encode and parse, `sameRef`. |
| `discovery.ts` | Builds the Import session list from `agent.list`. |
| `launch.ts` | `launchAgent`: workspace or tab creation, `agent.start`, readiness polling, cleanup on failure. |
| `restart.ts` | `restartAgent`: in-place SIGTERM and resume for "Restart to enable input". |
| `rpc.ts` | `registerManagementRpcs`: `herdr.target`, `herdr.overview`, `herdr.diagnostics`, `herdr.agent.restart`, `herdr.chat.ready`, `herdr.duplicates.archive` (compare-and-archive: re-reads the owner chat, never starts Herdr), `herdr.workspace.create`, `herdr.folders.suggest`; chat reconciliation per terminal. |
| `folders.ts` | Folder suggestion and `~` expansion. |
| `timeline.ts` | Stable-id diffing of transcript snapshots into `timeline.item` rows. |
| `file-tail.ts` | `FileTail`: incremental, torn-line-tolerant reads of a growing file. |
| `bound-sessions.ts`, `pane-claims.ts` | Registry of bound chats awaiting `herdr.chat.ready`; one active chat per terminal. |
| `host.ts` | `PaseoHost`: keeps the Paseo API handle captured from a lifecycle hook, for answering permissions. |
| `herdr-commands.ts` | Builds `herdr agent attach` and `pane read` commands. |
| `herdr/` | The Herdr seam: `client.ts` (requests, subscription, `checkHerdrStatus`, `MIN_HERDR_VERSION`), `schema.ts` (zod wire schemas), `target.ts` (settings and environment to a target; `TargetReadiness`, auto-start), `socket-path.ts`, `targets.ts` (`listPaneTargets`). |
| `harness/` | The adapter contract and routing. `types.ts` (`HarnessAdapter`), `registry.ts` (the registered list: OMP, generic), `resolve.ts` (kind to adapter), `process-identity.ts` (`processInstanceId`: pid plus start time). |
| `harness/omp/` | The OMP adapter: `adapter.ts`, `input.ts` (companion client), `transcript.ts` and `to-provider-items.ts` (session file to timeline), `forks.ts`, `companion-install.ts`, `companion-hash.ts` (generated), and `vendor/` (a trimmed copy of Paseo's OMP history mapper; see `VENDORED.md`). |
| `harness/generic/` | The generic adapter for any Herdr-detected kind without a dedicated adapter: `adapter.ts` (`agent.prompt` submit, shell refusal, identity), `screen.ts` (the pane's screen as one mutable row plus an in-memory prompt ledger). |

### `plugin/client/` and `plugin/index.client.tsx`

| Module | Role |
|---|---|
| `overview.tsx` | The Herdr screen: workspace cards, agent rows, restart and more sheets, new chat and new workspace forms, connection card. Polls `herdr.overview` every 4 s. |
| `folder-field.tsx` | Folder input with `herdr.folders.suggest` suggestions. |
| `settings.tsx` | Settings screen and the effective-target readout. |
| `actions.ts` | `createHerdrChat` (launch through the provider) and `bindHerdrChat` (attach to a running agent, then `herdr.chat.ready`). |
| `home.ts` | The composer pill that leads back to the Herdr screen in every `herdr-*` chat. |
| `catalog.ts` | Refreshes a provider's model list when a chat reports a model the list lacks. |
| `decision-row.tsx` | Renders the timeline row for a decided approval or question. |
| `sidebar.tsx`, `helpers.ts` | Sidebar entry; pure helpers (labels, target description, folder rules). |

### `plugin/shared/`

Code imported by both server and client: `rpc.ts` (RPC contracts and wire types for the overview), `settings.ts` (`herdrSettings`, setting id `herdr-connection`), `decision.ts` (decision row schema), `labels.ts`, `model.ts` (`NATIVE_DEFAULT_MODEL`, the `herdrBind` option key).

### `plugin/harness-extension/` and `plugin/scripts/`

`harness-extension/omp.ts` is the input companion, a single OMP extension file that is copied verbatim into OMP's extensions directory. It must stay self-contained.

`scripts/install-omp-companion.mjs` installs, updates and removes it; `scripts/sync-companion-hash.mjs` regenerates `server/harness/omp/companion-hash.ts`. `paseo-plugin.json` runs the installer as the plugin's build step.

### Tests: `plugin/test/`

Vitest. `fake-herdr.ts` is an in-process fake of Herdr's JSON API over a real Unix socket (seam 2), `fake-harness.ts` is a fake adapter, and `fixtures/omp/` holds OMP session files. `core-is-neutral.test.ts` drives the neutral session, binding, timeline and discovery code with the fake adapter, so it can't quietly depend on OMP.

## The adapter contract

Everything harness-specific sits behind `HarnessAdapter` (`server/harness/types.ts`): which Herdr agent kinds it claims, how to launch and resume it, how to find and read its transcript, how to submit a prompt, interrupt, read configuration, and read and resolve approvals. Optional members (`launch`, `readConfig`, `snapshotApprovals`, `findForks`, and so on) switch features on and off per adapter. The neutral modules (`session`, `live-session`, `turns`, `prompt`, `approvals`, `config`, `launch`, `restart`) call only this interface.

`resolve.ts` maps a Herdr agent kind to an adapter for new work (`select`) and validates an existing binding (`adapterAcceptsKind`). Two adapters are registered: OMP, and the generic adapter as the single `"any"` fallback, so a dedicated adapter always wins for its kind. The contract has a pane-bound binding mode (`binding: "pane"`), a status-based turn-evidence mode (`turnEvidence: "status"`) and a fallback adapter kind (`nativeKinds: "any"`); `listPaneTargets` is the single place that decides which panes can be bound. An adapter that serves several kinds can give per-kind Stop keys with the optional `interruptKeysFor(kind)`; an empty list refuses Stop. `listPaneTargets` adds `pane.list` plain-shell panes (synthetic entries with `agent: null`, status `unknown`, label "shell (runs as commands)") only when called with `includeShells`, which only a binding with `allowShell` does; the default listing is `agent.list` alone.

### The generic adapter

It drives any pane Herdr detects as an agent, with no companion and no native session:

- **Timeline.** One `assistant_message` row with the fixed id `generic:<terminalId>:screen` holds the pane's visible screen in a fenced block (`pane.read`, source `visible`: a `recent` read taller than the viewport makes Herdr scroll an idle alternate-screen TUI). Prompts sent from Paseo are remembered in memory and shown as `user_message` rows `generic:<terminalId>:user:<n>` ahead of it; nothing is persisted, so a reopened chat shows only the screen. `extendsPrevious` is always true and `chainIds` is empty, so a rewritten screen never reads as a branch; a failed read keeps the last good screen and never throws.
- **Prompts.** `agent.prompt` through `classifyHerdrPrompt`. A timeout or any error not proven to precede the write is uncertain and is never resent. Admission is the core's: Herdr `idle` or `done` only.
- **Turns.** Herdr status counters plus idle-settle (`turnEvidence: "status"`).
- **Identity.** The occupant is the shell itself: pid = Herdr's `shell_pid`, start time from `ps`, `occupant.shell = true`. `shellForeground` (`shell.ts`) reads `pane.process_info`: `idle` = the foreground group is the shell's own pid, every listed foreground process is that pid, the leader is a command shell by kernel name (`COMMAND_SHELLS`; multiplexers and `login` are only in the not-an-agent list) and its argv has no operand; `busy` = another group, or another process in the shell's group, holds the foreground; `exec` = the shell's pid now runs a non-shell or a script, `unknown` = not enough data. A changed shell pid or tty, a changed start time, `exec`, an exited shell or a detected agent freeze the binding; a `ps` or `pane.process_info` failure is `unknown` (prompts refused, nothing ends early; the reported counters are the tracker's own). On the first validation with no occupant, a pane with no detected agent that is not at an idle prompt freezes instead of binding the foreground program. The shell track moves only inside `commitValidated`, after the ordering check.
- **Refusals.** A shell or multiplexer as the foreground leader (`isOccupant` false), and, on first bind, a kind another adapter owns. A binding with `allowShell` is the one exception (next section).
- **Stop.** `esc` for a detected kind. Approvals stay in the terminal (Herdr `blocked` raises the "needs approval" notice).

### Shell opt-in (`allowShell`)

A third piece of the adapter contract, `HarnessAdapter.shell` (`ShellSupport`: `isShell`, `submit`, `interruptKeys`, `notice`), is implemented by the generic adapter. It is used only by a binding whose persisted `allowShell` is true; everything else is the paragraph above, unchanged.

- **Flag and gate.** `Binding.allowShell`, default false, persisted (`persistenceOf` omits it when false). Set at bind time by `allowShell` in the `herdrBind` option (refused when Herdr detects an agent in the pane) and toggled by `herdr.chat.allow-shell {agentId, enabled}` through `OpenSessions` (keyed by the `PASEO_AGENT_ID` of the session's env). The flag acts only while the host-scoped plugin setting `allowShell` (`shared/settings.ts`, default off, written only by the settings UI) is on: `SessionDeps.shellAllowed` is read on every validation and before each write, and when it is off the binding is treated as flag-off (flag deleted and persisted, shell occupant frozen; turning the setting on again does not re-arm). Off by RPC freezes synchronously (`setAllowShell`), which bumps the generation so an in-flight prompt stops; an RPC off for a closed chat is remembered in `OpenSessions.revoked` (in memory) and clears the flag at the next open, because the plugin cannot rewrite Paseo's stored persistence.
- **Identity.** The occupant is the shell itself: pid = Herdr's `shell_pid`, start time from `ps`, `occupant.shell = true`. `shellForeground` (`shell.ts`) reads `pane.process_info`: `idle` = the foreground group is the shell's own pid and its leader is a shell, `busy` = another group holds the foreground, `exec` = the shell's pid now runs a non-shell, `unknown` = not enough data. A changed shell pid or tty, a changed start time, `exec`, an exited shell or a detected agent freeze the binding; a `ps` or `pane.process_info` failure is `unknown` (prompts refused, nothing ends early).
- **Turns (`turnEvidence` "process").** The session derives a status for the tracker: `idle` while the shell holds the foreground, `working` while a child does, with counters that move on each change and on each return. The tracker's process mode ends a turn the moment the foreground returns after a child was seen; a shell that stayed idle ends it after `processNoActivitySettleMs` (1.5 s) without the agent-style "no activity" notice. Polling is the existing 2 s reconcile: a `pane.process_info` plus, for a flagged binding, a `pane.list` (`includeShells`) and a plugin-setting read per validation. A prompt that starts an interactive child keeps the turn working until the child exits (fails closed).
- **Submit.** One line only, at most 1000 UTF-8 bytes (no newline or control character: rejected, nothing written). Right before the write the foreground is re-read and `ctx.stillAllowed()` (generation, flag, plugin setting, read fresh) is checked, again after the line is cleared. Then `pane.send_keys ["ctrl+e","ctrl+u"]` (clear the line editor; vi-mode command mode can keep text), `pane.send_text` and `pane.send_keys ["enter"]`. A failed clear is a rejection (nothing typed). An error or timeout after the text or Enter writes is uncertain, never resent, and sets the session's `shellUncertain`: shell prompts are then refused, whatever Stop or the settle window does to the turn, until the conversation is reopened or `herdr.chat.shell-acknowledge` is called. A delivered prompt is recorded in the generic prompt ledger. The notice "Prompt text runs as shell commands." shows when the conversation opens with the flag on and with every delivered prompt.
- **Stop.** `ctrl+c` only while a child holds the foreground; nothing when the shell is idle or unknown.

## Session binding

A chat is bound to a Herdr terminal, not to a pane id, and the binding is persisted with the Paseo chat (`persistenceOf` in `binding.ts`, version 1):

| Field | Meaning |
|---|---|
| `harness`, `herdrSession` | Adapter id; the named Herdr session (null = default). |
| `terminalId`, `agentName` | The Herdr terminal and agent name. |
| `sessionRef` | The native session (`path` or `id`), as Herdr reports it. |
| `cwd` | Working directory. |
| `submittedMessages` | Maps transcript user entries to Paseo message ids (capped at 256). |
| `occupant` | `{ pid, tty, instanceId }` of the validated OMP process, set on first successful validation. |
| `decisions` | Decided approval rows, capped at 64. |

Three ways to get a bound session: **create** (`session.create`: `launchAgent`, then open), **bind** (`session.open` with the `herdrBind` option from `bindHerdrChat`: attach to a running agent, then re-send its history as live rows once the client calls `herdr.chat.ready`, because Paseo drops rows sent before it subscribes), and **reopen** from persistence after a reload.

`validateAgent` runs before every prompt and on every reconcile. It re-lists agents, checks the terminal, its kind, the native session, and the foreground process via `pane.process_info`, then asks the companion to `inspect`. Any mismatch calls `freeze`, which makes the session read-only, withdraws open approval cards and emits one warning notice. Input is never sent after a freeze. If the terminal id has vanished, the session recovers only when exactly one agent has the same native session ref and the chat already holds retained process evidence (`occupant`); otherwise it freezes. `paneClaims` ensures only one active chat controls a terminal; a read-only chat doesn't block a fresh one.

A persisted chat reopens only against the Herdr session it was created on (`provider.ts`, `session.open` with persistence).

## Turn lifecycle

1. **Admission** (`prompt.ts`): reject unless the session is active and connected, no turn is running, the agent is idle or done, the transcript shows no unfinished turn, and the message is plain text. Revalidate the agent, reserve a turn in the tracker, then submit through the companion. The companion refuses when OMP is working, has queued messages or a terminal draft.
2. **Delivery result**: `accepted`, `rejected` (definite, before any write; the tracker reports `prompt_failed`) or `uncertain` (a write may have happened; never resent, the tracker keeps the reservation until the transcript or Herdr status decides).
3. **Observation** (`live-session.ts`): Herdr `events.subscribe` notifications for the pane, plus a 2 s poll and transcript file changes, trigger `reconcile`. Each reconcile validates the agent, feeds the tracker Herdr's `agent_status`, reads the transcript, and emits only the timeline rows whose content hash changed (`timeline.ts`).
4. **End of turn**: for OMP (`turnEvidence: "transcript"`) a turn ends when Herdr shows idle or done and the transcript's last turn entry is new and known (completed, aborted, error). A turn started in the terminal has no Paseo prompt and is synthesised from Herdr `working` or a new user entry.
5. **Stop**: `interrupt` sends the adapter's `interruptKeys` (`esc`) with `pane.send_keys`; the tracker warns if the turn hasn't ended after 10 s, and cancels a Stop that landed before OMP recorded the prompt. If delivery was uncertain and Herdr shows the pane idle or done, Stop sends no key and releases the reservation instead.
6. **Connectivity**: a lost Herdr connection suspends input and emits a notice; after 60 s of outage an in-flight turn is failed instead of left open.

## Companion install, hash and migration

The companion file, `harness-extension/omp.ts`, exists in three forms that must agree:

| Form | Where | Used for |
|---|---|---|
| Source | `plugin/harness-extension/omp.ts` | What the installer copies. |
| Installed | `<OMP agent dir>/extensions/paseo4herdr-input.ts` | What OMP loads. First line is the marker `// paseo4herdr OMP input companion.` |
| Hash | `server/harness/omp/companion-hash.ts` (`COMPANION_SHA256`) | What the server compares the installed file against. |

The server can't read the source at runtime because Paseo bundles plugin server code as CommonJS, where `import.meta.url` is empty; so the hash is generated at development time. After any change to `harness-extension/omp.ts`, run `cd plugin && npm run sync:companion-hash` and commit the regenerated file.

`companionInstallStatus()` (`server/harness/omp/companion-install.ts`) classifies the installed file:

| State | Condition |
|---|---|
| `current` | Hash matches and no legacy file we wrote is present. |
| `outdated` | Marker present but hash differs; or only the legacy file is present; or the current file coexists with a legacy file we wrote. |
| `foreign` | The file exists without our marker. |
| `missing` | No file. |

`scripts/install-omp-companion.mjs` mirrors the directory resolution (`PI_CODING_AGENT_DIR`, else `<home>/<PI_CONFIG_DIR or .omp>/agent`, then `extensions`) and the file name and marker constants of `companion-install.ts`; keep the two in sync by hand, since the script is plain Node with no build step. It never overwrites a file without the marker unless `--force`, writes through a temp file and `rename`, and refuses to run if the agent directory doesn't exist.

**Migration from `paseo-herdr`.** The old companion `paseo-herdr-input.ts` has the marker `// paseo-herdr OMP input companion.` On install and update the script removes it if the marker matches, leaves it with a message otherwise, and `--uninstall` removes both. A failure to remove it makes the script exit 1 with instructions, because OMP would load two companions. The server reports a lone or coexisting legacy file as `outdated`. The companion itself reads the old approval-wrapper symbol (`paseo-herdr.approvals`) so that a new instance unwraps a leftover wrapper rather than stacking on it.

## Running the checks

```bash
cd plugin
npm install --legacy-peer-deps
npm run typecheck          # tsc for server/shared/tests, then the client config
npm test                   # vitest run
npx vitest run test/<file>.test.ts
```

`npm run typecheck` runs `tsc --noEmit` and `tsc --noEmit -p tsconfig.client.json`.

To try a working copy in Paseo, run `paseo plugin install /absolute/path/to/plugin`, then `npm run install:omp-companion` (directory installs don't run the build step), then `paseo plugin logs herdr-harness` while you exercise it.

## Conventions

- Server code never imports from `@getpaseo/client` or `@getpaseo/server`; types come from `@getpaseo/plugin`, because the plugin compiler can't resolve other packages in an install without `node_modules`. The OMP history mapper is vendored for the same reason.
- Anything a user can read is written for them: error and notice strings name what happened and what to do. The docs ([TROUBLESHOOTING.md](TROUBLESHOOTING.md)) quote those strings; change both together.
- Uncertain outcomes are reported as uncertain, and never retried.
