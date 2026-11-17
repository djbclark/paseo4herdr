---
title: "Paseo renders a structured timeline, not a TUI — neither bridge can reuse a TUI screen"
author: Daniel
date: 2026-11-17
branch: main
cost: { minutes: 1, tokens: 36991 }
id: l-917c0c61
scope: repo
status: active
src: agent
---

## Watch out

Paseo builds its agent chat from a structured **timeline**, never from a terminal/TUI. Each provider adapter (Claude Agent SDK, @opencode-ai/sdk, Pi JSONL-RPC over stdio) emits typed `AgentTimelineItem`s (`user_message`, `assistant_message`, `reasoning`, `tool_call`, `todo`, `error`, `notification`), which the daemon stores and serves. `paseo logs`/`paseo attach` are **lossy text serializations** of that timeline — their `printTimelineItem` switch is where the `[User]`/`[Thought]`/`[Shell]` tags come from. The app's rich chat is a projection of those structured items, not a reformatted TUI.

Consequences for this repo and herdr4paseo:

1. There is no TUI screen to reconstruct here: this plugin sees OMP only via its session file, the companion, and Herdr's socket. `@getpaseo/plugin` offers React components + timeline items but **no terminal/PTY surface**, so a plugin can't redraw a live agent TUI (closest is the generic adapter's fenced `pane.read` snapshot). Paseo's own PTY terminal feature only owns terminals the daemon spawns, so it can't attach an external Herdr pane, and it isn't exposed to plugins.
2. The daemon WebSocket serves the raw timeline directly: `fetch_agent_timeline_request` (paged, `projection: projected|canonical`) and `agent.timeline.set_subscription.request` (live updates). A terminal client wanting a real chat should consume those, not `paseo logs` — this is herdr4paseo's existing `list_commands_request` seam.

In the code:
- getpaseo/paseo: `packages/server/src/server/agent/agent-sdk-types.ts` (AgentTimelineItem/AgentStreamEvent); `packages/protocol/src/messages.ts` (fetch_agent_timeline_request, agent.timeline.set_subscription.request, list_commands_request); `packages/cli/src/commands/agent/{logs,attach}.ts` (printTimelineItem); `packages/plugin/src/client/ui.ts` (Markdown/StreamedText, no terminal).
