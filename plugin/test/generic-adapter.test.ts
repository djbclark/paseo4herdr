import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { HerdrHarnessSession } from "../server/session.js";
import { bindingOf } from "../server/binding.js";
import { HerdrError } from "../server/herdr/client.js";
import type { AgentInfo, PaneProcessInfo } from "../server/herdr/schema.js";
import type { HarnessAdapter, HerdrRequestFn, PaneObservation, TranscriptSnapshot } from "../server/harness/types.js";
import { createResolver } from "../server/harness/resolve.js";
import { harnesses } from "../server/harness/registry.js";
import { genericAdapter, isShellProcess } from "../server/harness/generic/adapter.js";
import { openScreenReader, promptRowId, screenRowId } from "../server/harness/generic/screen.js";
import { ompAdapter } from "../server/harness/omp/adapter.js";
import { processInstanceId } from "../server/harness/process-identity.js";

// Process identity shells out to `ps`; every test drives it through this stub.
vi.mock("../server/harness/process-identity.js", () => ({ processInstanceId: vi.fn() }));
const psId = vi.mocked(processInstanceId);

const config = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };
const prompt = (id: string, text = "hello"): ProviderPrompt => ({ clientMessageId: id, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } });
const agentOf = (overrides: Partial<AgentInfo> = {}): AgentInfo => ({
  terminal_id: "t1", pane_id: "pane-1", agent: "grok", name: null, agent_status: "idle", agent_session: null,
  workspace_id: "w", tab_id: "t", focused: true, screen_detection_skipped: false, state_labels: {}, tokens: {},
  launch_pending: false, interactive_ready: true, state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0, ...overrides });
const procOf = (name: string, argv0: string | null = name, pid = 100): PaneProcessInfo => ({ pane_id: "pane-1", foreground_process_group_id: pid, tty: "/dev/ttys001",
  foreground_processes: [{ pid, name, argv0 }] });

beforeEach(() => {
  psId.mockReset();
  psId.mockImplementation(async (pid) => `${pid}@Sat Oct 31 00:33:57 2026`);
});

/* ---------- screen reader ---------- */

function observationOf(screen: { text: string | Error }, terminalId = "t1"): { observation: PaneObservation; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const request: HerdrRequestFn = async (method, params) => {
    calls.push(params ?? {});
    if (method === "agent.prompt") return { type: "agent_prompted", agent: agentOf({ terminal_id: terminalId }) };
    if (screen.text instanceof Error) throw screen.text;
    return { type: "pane_read", read: { pane_id: "pane-1", text: screen.text } };
  };
  return { observation: { terminalId, herdrSession: null, paneId: () => "pane-1", request, signal: new AbortController().signal }, calls };
}
const screenItem = (snapshot: TranscriptSnapshot) => snapshot.items.find((item) => item.id.endsWith(":screen"));

describe("generic screen reader", () => {
  it("shows the pane as one row whose id is fixed while its text changes", async () => {
    const screen = { text: "first screen" as string | Error };
    const { observation, calls } = observationOf(screen);
    const reader = openScreenReader(observation);
    const first = await reader.snapshot();
    screen.text = "second screen, different";
    const second = await reader.snapshot();
    expect(first.items.map((item) => item.id)).toEqual([screenRowId("t1")]);
    expect(second.items.map((item) => item.id)).toEqual([screenRowId("t1")]);
    expect(screenItem(first)).toMatchObject({ type: "assistant_message", text: "```\nfirst screen\n```" });
    expect(screenItem(second)).toMatchObject({ text: "```\nsecond screen, different\n```" });
    expect(calls[0]).toMatchObject({ pane_id: "pane-1", strip_ansi: true });
  });

  it("never reads a rewritten screen as a branched conversation, and keeps chainIds empty", async () => {
    const screen = { text: "alpha\nbeta" as string | Error };
    const reader = openScreenReader(observationOf(screen).observation);
    const before = await reader.snapshot();
    screen.text = "completely different content";
    const after = await reader.snapshot();
    expect(after.extendsPrevious(before)).toBe(true);
    expect(before.chainIds).toEqual([]);
    expect(after.chainIds).toEqual([]);
  });

  it("returns the last good snapshot when a read fails or answers garbage, and never throws", async () => {
    const screen = { text: "good screen" as string | Error };
    const { observation } = observationOf(screen);
    const reader = openScreenReader(observation);
    const good = await reader.snapshot();
    screen.text = new Error("socket closed");
    const failed = await reader.snapshot();
    expect(failed.items).toEqual(good.items);
    expect(failed.extendsPrevious(good)).toBe(true);
    const garbage = openScreenReader({ ...observation, request: async () => ({ type: "nope" }) });
    expect((await garbage.snapshot()).items).toEqual([]); // nothing good yet: an empty timeline, not a throw
  });

  it("does not read a pane that is not placed yet", async () => {
    const { observation, calls } = observationOf({ text: "x" });
    const reader = openScreenReader({ ...observation, paneId: () => null });
    expect((await reader.snapshot()).items).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("puts the ledger's user rows, in send order, before the screen row, and counts ids past the cap", async () => {
    const { observation } = observationOf({ text: "screen" });
    const reader = openScreenReader(observation);
    const send = (text: string) => genericAdapter.submitPrompt({ pid: 1, ref: null, instanceId: "i", paneId: "pane-1", terminalId: "t1", agentKind: "grok" }, text,
      { signal: new AbortController().signal, request: observation.request });
    expect(await send("first")).toEqual({ type: "accepted" });
    expect(await send("second")).toEqual({ type: "accepted" });
    const snapshot = await reader.snapshot();
    expect(snapshot.items.map((item) => item.id)).toEqual([promptRowId("t1", 1), promptRowId("t1", 2), screenRowId("t1")]);
    expect(snapshot.items.slice(0, 2).map((item) => item.type === "user_message" ? item.text : null)).toEqual(["first", "second"]);
    for (let i = 0; i < 55; i++) await send(`bulk ${i}`);
    const capped = (await reader.snapshot()).items.filter((item) => item.type === "user_message");
    expect(capped).toHaveLength(50);
    expect(capped.at(-1)?.id).toBe(promptRowId("t1", 57)); // ids keep counting; the oldest rows dropped off
  });

  it("fences screen text so a backtick run inside it cannot close the block", async () => {
    const reader = openScreenReader(observationOf({ text: "code:\n```js\nx\n```\n" }).observation);
    const row = screenItem(await reader.snapshot());
    expect(row).toMatchObject({ text: "````\ncode:\n```js\nx\n```\n````" });
  });

  it("trims trailing whitespace and blank edge lines so an idle screen does not churn", async () => {
    const screen = { text: "\n\nprompt>   \n\n" as string | Error };
    const reader = openScreenReader(observationOf(screen).observation);
    const a = await reader.snapshot();
    screen.text = "prompt>\n";
    const b = await reader.snapshot();
    expect(screenItem(a)).toEqual(screenItem(b));
  });
});

/* ---------- adapter surface ---------- */

describe("generic adapter", () => {
  it("is the single fallback, with no native session, no companion and no launch", () => {
    expect(genericAdapter).toMatchObject({ id: "generic", nativeKinds: "any", binding: "pane", turnEvidence: "status", herdrIntegration: null });
    expect(genericAdapter.launch).toBeUndefined();
    expect(genericAdapter.resumeArgs).toBeUndefined();
    expect(genericAdapter.configure).toBeUndefined();
    expect(genericAdapter.snapshotApprovals).toBeUndefined();
  });

  it("a dedicated adapter wins for its kind; the generic adapter takes the rest", () => {
    const resolver = createResolver(harnesses);
    expect(resolver.select("omp")).toBe(ompAdapter);
    expect(resolver.select("grok")).toBe(genericAdapter);
    expect(resolver.select(null)).toBe(genericAdapter);
  });

  it("locates a pane-bound transcript only with a live pane", async () => {
    const { observation } = observationOf({ text: "x" }, "term-9");
    expect(await genericAdapter.resolveTranscript(null, { cwd: "/w" })).toBeNull();
    expect(await genericAdapter.resolveTranscript(null, { cwd: "/w", pane: observation })).toMatchObject({ path: "herdr-pane:term-9", nativeSessionKey: "term-9", pane: observation });
  });

  it("treats shells and multiplexers as non-occupants, by name, argv0, login-shell dash or path", () => {
    for (const shell of ["bash", "zsh", "fish", "sh", "dash", "nu", "login", "tmux"]) {
      expect(genericAdapter.isOccupant(procOf(shell)), shell).toBe(false);
    }
    expect(genericAdapter.isOccupant(procOf("-zsh"))).toBe(false);
    expect(genericAdapter.isOccupant(procOf("3.1.0", "/bin/bash"))).toBe(false);
    expect(isShellProcess({ name: "-fish" })).toBe(true);
  });

  it("accepts a prompt reply only for the agent kind seen at validation", async () => {
    const { observation } = observationOf({ text: "screen" });
    const send = (agentKind: string | null) => genericAdapter.submitPrompt({ pid: 1, ref: null, instanceId: "i", paneId: "pane-1", terminalId: "t1", agentKind }, "hi",
      { signal: new AbortController().signal, request: observation.request });
    expect(await send("grok")).toEqual({ type: "accepted" });
    expect((await send("claude")).type).toBe("uncertain");
    expect((await send(null)).type).toBe("uncertain");
  });

  it("accepts an agent leader even when its process title is a version string", () => {
    expect(genericAdapter.isOccupant(procOf("2.1.314", "claude"))).toBe(true);
    expect(genericAdapter.isOccupant(procOf("grok", null))).toBe(true);
    expect(genericAdapter.isOccupant(procOf("constructor", null))).toBe(true); // not a shell, and not an Object.prototype hit
  });

  it("needs a foreground leader that is actually in the process list", () => {
    expect(genericAdapter.isOccupant({ pane_id: "p", foreground_process_group_id: null, foreground_processes: [{ pid: 5, name: "grok" }] })).toBe(false);
    expect(genericAdapter.isOccupant({ pane_id: "p", foreground_process_group_id: 9, foreground_processes: [{ pid: 5, name: "grok" }] })).toBe(false);
  });

  it("identifies the process instance by pid and start time", async () => {
    psId.mockResolvedValueOnce("42@Sat Oct 31 00:33:57 2026");
    expect(await genericAdapter.inspectInput({ pid: 42, ref: null })).toEqual({ pid: 42, instanceId: "42@Sat Oct 31 00:33:57 2026" });
    expect(psId).toHaveBeenCalledWith(42);
  });

  it("Stop keys: esc for a detected kind, none for an unidentified one", () => {
    expect(genericAdapter.interruptKeysFor?.("grok")).toEqual(["esc"]);
    expect(genericAdapter.interruptKeysFor?.(null)).toEqual([]);
  });
});

/* ---------- session level ---------- */

const sessions: HerdrHarnessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });

interface WorldOptions { adapter?: HarnessAdapter; agent?: Partial<AgentInfo>; process?: PaneProcessInfo; routesNewWork?: (kind: string | null | undefined) => boolean }

/** One Herdr stand-in: a mutable agent, foreground process and screen, plus a log of every request. */
async function world(options: WorldOptions = {}) {
  const agent = agentOf(options.agent);
  const adapter = options.adapter ?? genericAdapter;
  const state = { process: options.process ?? procOf("grok"), screen: "initial screen" as string | Error, promptError: null as Error | null };
  const log: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const events: ProviderEvent[] = [];
  const request: HerdrRequestFn = async (method, params) => {
    log.push({ method, params });
    if (method === "pane.process_info") return { type: "pane_process_info", process_info: structuredClone(state.process) };
    if (method === "pane.read") {
      if (state.screen instanceof Error) throw state.screen;
      return { type: "pane_read", read: { pane_id: "pane-1", text: state.screen } };
    }
    if (method === "agent.prompt") {
      if (state.promptError) throw state.promptError;
      return { type: "agent_prompted", agent: structuredClone(agent) };
    }
    return { type: "ok" };
  };
  const session = new HerdrHarnessSession("s", bindingOf(agent, adapter, null), {
    adapter, listAgents: async () => [structuredClone(agent)], request,
    subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
    emit: (event) => events.push(event),
    ...(options.routesNewWork ? { routesNewWork: options.routesNewWork } : {}),
  });
  sessions.push(session);
  await session.open(config, "skip");
  await session.live.reconcile();
  const count = (method: string) => log.filter((entry) => entry.method === method).length;
  return { session, agent, state, log, events, count };
}
const noticeTitles = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.notice" ? [e.notice.title] : []);
const promptResults = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.prompt_result" ? [`${e.clientMessageId}:${e.result.type}`] : []);
const turnStates = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.turn" ? [e.state] : []);
const timelineRows = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "timeline.item" ? [e.item] : []);

describe("generic adapter in a session", () => {
  it("opens an idle agent on the screen row and takes a prompt through agent.prompt", async () => {
    const { session, events, log, count } = await world();
    expect(session.state.outcome).toBe("active");
    await session.prompt(prompt("p1", "do the thing"));
    expect(promptResults(events)).toEqual(["p1:turn"]);
    expect(log.find((entry) => entry.method === "agent.prompt")?.params).toEqual({ target: "pane-1", text: "do the thing" });
    expect(count("pane.send_keys")).toBe(0); // submission is agent.prompt, never raw keystrokes
  });

  it("admits a prompt only while Herdr says idle or done", async () => {
    for (const status of ["working", "blocked", "unknown"] as const) {
      const { session, events, count } = await world({ agent: { agent_status: status } });
      await session.prompt(prompt("p1"));
      expect(promptResults(events), status).toEqual(["p1:failed"]);
      expect(count("agent.prompt"), status).toBe(0);
      session.close();
    }
    const done = await world({ agent: { agent_status: "done" } });
    await done.session.prompt(prompt("p1"));
    expect(promptResults(done.events)).toEqual(["p1:turn"]);
  });

  it("a definite Herdr rejection (agent_not_ready) fails the prompt, starts no turn and is not ledgered", async () => {
    const { session, state, events, count } = await world();
    state.promptError = new HerdrError("agent_not_ready", "Agent is not ready");
    await session.prompt(prompt("p1", "ignored"));
    expect(promptResults(events)).toEqual(["p1:failed"]);
    expect(turnStates(events)).toEqual([]);
    expect(count("agent.prompt")).toBe(1);
    const rows = timelineRows(events).filter((item) => item.type === "user_message");
    expect(rows).toEqual([]);
  });

  it("a timeout is uncertain, starts the turn, and the prompt is never resent", async () => {
    const { session, state, events, count } = await world();
    state.promptError = new Error("request timed out");
    await session.prompt(prompt("p1"));
    expect(promptResults(events)).toEqual(["p1:turn"]);
    expect(noticeTitles(events)).toContain("Prompt delivery is uncertain");
    await session.live.reconcile();
    await session.live.reconcile();
    await session.prompt(prompt("p2", "again")); // still uncertain: refused, not forwarded
    expect(promptResults(events)).toEqual(["p1:turn", "p2:failed"]);
    expect(count("agent.prompt")).toBe(1);
  });

  it("refuses a pane whose foreground process is a shell at open, without sending anything", async () => {
    const { session, events, count } = await world({ process: procOf("zsh") });
    expect(session.state.outcome).toBe("readonly");
    expect(noticeTitles(events)).toContain("The bound agent was replaced");
    await session.prompt(prompt("p1", "rm -rf nothing"));
    expect(count("agent.prompt")).toBe(0);
    expect(count("pane.send_keys")).toBe(0);
  });

  it("freezes when the agent exits back to a shell, and sends nothing after", async () => {
    const { session, state, events, count } = await world();
    state.process = procOf("-zsh");
    await session.live.reconcile();
    expect(session.state.outcome).toBe("readonly");
    await session.prompt(prompt("p1", "ls"));
    expect(promptResults(events)).toEqual(["p1:failed"]); // read-only: refused before anything is sent
    expect(count("agent.prompt")).toBe(0);
  });

  it("freezes when the process start time changes under the same pid", async () => {
    const { session, events, count } = await world();
    psId.mockImplementation(async (pid) => `${pid}@Sun Nov  1 09:00:00 2026`);
    await session.live.reconcile();
    expect(session.state.outcome).toBe("readonly");
    expect(noticeTitles(events)).toContain("The bound agent was replaced");
    await session.prompt(prompt("p1"));
    expect(count("agent.prompt")).toBe(0);
  });

  it("a ps failure means cannot validate: the prompt is rejected, the chat is not frozen as replaced, and it recovers", async () => {
    const { session, events, count } = await world();
    psId.mockRejectedValue(new Error("ps timed out"));
    await session.prompt(prompt("p1"));
    expect(promptResults(events)).toEqual(["p1:failed"]);
    expect(count("agent.prompt")).toBe(0);
    expect(session.state.outcome).toBe("active");
    expect(noticeTitles(events)).not.toContain("The bound agent was replaced");
    psId.mockImplementation(async (pid) => `${pid}@Sat Oct 31 00:33:57 2026`);
    await session.live.reconcile();
    await session.prompt(prompt("p2"));
    expect(promptResults(events)).toEqual(["p1:failed", "p2:turn"]);
  });

  it("does not drive a pane first seen as a kind another adapter owns", async () => {
    const resolver = createResolver(harnesses);
    const { session, events, count } = await world({ agent: { agent: "omp" }, routesNewWork: (kind) => resolver.select(kind) === genericAdapter });
    expect(session.state.outcome).toBe("readonly");
    expect(noticeTitles(events)).toContain("This pane is handled by another provider");
    await session.prompt(prompt("p1"));
    expect(count("agent.prompt")).toBe(0);
  });

  it("keeps driving an already-bound pane that Herdr later detects as another kind", async () => {
    const resolver = createResolver(harnesses);
    const { session, agent, events } = await world({ routesNewWork: (kind) => resolver.select(kind) === genericAdapter });
    agent.agent = "omp";
    await session.live.reconcile();
    expect(session.state.outcome).toBe("active");
    await session.prompt(prompt("p1"));
    expect(promptResults(events)).toEqual(["p1:turn"]);
  });

  it("ends the turn on Herdr's status alone: working, then idle held past the settle", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const { session, agent, events } = await world();
      await session.prompt(prompt("p1"));
      agent.agent_status = "working"; agent.state_change_seq = 1;
      await session.live.reconcile();
      agent.agent_status = "idle"; agent.state_change_seq = 2;
      await session.live.reconcile();
      expect(turnStates(events)).toEqual(["started"]);
      await vi.advanceTimersByTimeAsync(3_100);
      expect(turnStates(events)).toEqual(["started", "completed"]);
    } finally { vi.useRealTimers(); }
  });

  it("Stop sends esc to the pane", async () => {
    const { session, agent, log } = await world();
    await session.prompt(prompt("p1"));
    agent.agent_status = "working"; agent.state_change_seq = 1;
    await session.live.reconcile();
    await session.interrupt("stop-1");
    const keys = log.filter((entry) => entry.method === "pane.send_keys");
    expect(keys).toHaveLength(1);
    expect(keys[0]!.params).toEqual({ pane_id: "pane-1", keys: ["esc"] });
  });

  it("Stop with an empty key list sends nothing and says so", async () => {
    const adapter: HarnessAdapter = { ...genericAdapter, interruptKeysFor: () => [] };
    const { session, agent, events, count } = await world({ adapter });
    await session.prompt(prompt("p1"));
    agent.agent_status = "working"; agent.state_change_seq = 1;
    await session.live.reconcile();
    await session.interrupt("stop-1");
    expect(count("pane.send_keys")).toBe(0);
    expect(noticeTitles(events)).toContain("Stop is not available for this agent");
    expect(events.some((e) => e.type === "request.completed" && e.requestId === "stop-1")).toBe(true);
  });

  it("an adapter without interruptKeysFor keeps using its static interruptKeys", async () => {
    const plain: HarnessAdapter = { ...genericAdapter, interruptKeys: ["ctrl+c"] };
    delete plain.interruptKeysFor;
    const { session, agent, log } = await world({ adapter: plain });
    await session.prompt(prompt("p1"));
    agent.agent_status = "working"; agent.state_change_seq = 1;
    await session.live.reconcile();
    await session.interrupt("stop-1");
    expect(log.find((entry) => entry.method === "pane.send_keys")?.params).toEqual({ pane_id: "pane-1", keys: ["ctrl+c"] });
  });

  it("emits the screen row under one id as the screen changes, and survives a total rewrite", async () => {
    const { session, state, events } = await world();
    state.screen = "line one";
    await session.live.reconcile();
    state.screen = "nothing like before";
    await session.live.reconcile();
    const screens = timelineRows(events).filter((item) => item.id === screenRowId("t1"));
    expect(screens.map((item) => item.type === "assistant_message" ? item.text : "")).toEqual([
      "```\nline one\n```", "```\nnothing like before\n```"]);
    expect(session.state.outcome).toBe("active"); // a rewritten screen never reads as a branch
  });

  it("keeps the chat alive and the last screen when the pane read fails", async () => {
    const { session, state } = await world();
    state.screen = new Error("pane read failed");
    await session.live.reconcile();
    expect(session.state.outcome).toBe("active");
    expect(session.state.connected).toBe(true);
    expect(session.state.snapshot?.items.map((item) => item.id)).toEqual([screenRowId("t1")]);
  });

  it("shows prompts sent from Paseo as user rows ahead of the screen row", async () => {
    const { session, events } = await world();
    await session.prompt(prompt("p1", "first question"));
    await session.live.reconcile();
    const ids = session.state.snapshot?.items.map((item) => item.id);
    expect(ids).toEqual([promptRowId("t1", 1), screenRowId("t1")]);
    expect(session.state.snapshot?.items[0]).toMatchObject({ type: "user_message", text: "first question" });
    expect(timelineRows(events).filter((item) => item.type === "user_message")).toHaveLength(1);
  });

  it("a reopened chat, or another session on the same terminal id, shows none of an earlier session's prompts", async () => {
    const a = await world();
    await a.session.prompt(prompt("p1", "secret to session A"));
    const b = await world();
    await b.session.live.reconcile();
    expect(b.session.state.snapshot?.items.map((item) => item.id)).toEqual([screenRowId("t1")]);
  });

  it("an unchanged screen emits no further rows and never freezes the chat", async () => {
    const { session, events } = await world();
    const before = timelineRows(events).length;
    await session.live.reconcile();
    await session.live.reconcile();
    expect(timelineRows(events).length).toBe(before);
    expect(session.state.outcome).toBe("active");
  });
});
