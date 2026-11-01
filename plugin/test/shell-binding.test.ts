import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import { HerdrHarnessSession } from "../server/session.js";
import { bindingOf, parseBinding, persistenceOf } from "../server/binding.js";
import { HerdrError } from "../server/herdr/client.js";
import { listPaneTargets } from "../server/herdr/targets.js";
import type { AgentInfo, PaneProcessInfo } from "../server/herdr/schema.js";
import type { HerdrRequestFn } from "../server/harness/types.js";
import { genericAdapter } from "../server/harness/generic/adapter.js";
import { processInstanceId } from "../server/harness/process-identity.js";
import { OpenSessions } from "../server/bound-sessions.js";
import { registerManagementRpcs } from "../server/rpc.js";
import { herdrChatAllowShellRpc, herdrChatShellAcknowledgeRpc } from "../shared/rpc.js";

vi.mock("../server/harness/process-identity.js", () => ({ processInstanceId: vi.fn() }));
const psId = vi.mocked(processInstanceId);

const prompt = (id: string, text = "ls -la"): ProviderPrompt => ({ clientMessageId: id, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } });
const shellPane = (overrides: Partial<AgentInfo> = {}): AgentInfo => ({
  terminal_id: "t1", pane_id: "pane-1", agent: null, name: null, agent_status: "unknown", agent_session: null,
  workspace_id: "w", tab_id: "t", focused: true, screen_detection_skipped: true, state_labels: {}, tokens: {},
  launch_pending: false, interactive_ready: false, state_change_seq: 0, completion_seq: null, cwd: "/work", revision: 0, ...overrides });

const SHELL_PID = 100;
const process_ = (foreground: number | null, leader: string, extra: Partial<PaneProcessInfo> = {}): PaneProcessInfo => ({
  pane_id: "pane-1", shell_pid: SHELL_PID, foreground_process_group_id: foreground, tty: "/dev/ttys001",
  foreground_processes: foreground === null ? [] : [{ pid: foreground, name: leader, argv0: leader }], ...extra });
const idle = () => process_(SHELL_PID, "zsh");
const busy = () => process_(200, "sleep");

beforeEach(() => {
  psId.mockReset();
  psId.mockImplementation(async (pid) => `${pid}@Sat Oct 31 00:33:57 2026`);
  vi.useFakeTimers({ toFake: ["Date"] });
});

const sessions: HerdrHarnessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); vi.useRealTimers(); });

/** One Herdr stand-in: a plain shell pane that only `listAgents({includeShells})` can see, a mutable foreground and a request log. */
async function world(options: { allowShell?: boolean; setting?: boolean; revoked?: boolean; process?: PaneProcessInfo; env?: Record<string, string> } = {}) {
  const state = { setting: options.setting ?? true, holdRead: null as Promise<void> | null, holdInfo: null as { nth: number; promise: Promise<void>; seen: number } | null, process: options.process ?? idle(), sendText: null as Error | null, sendKeys: null as Error | null, clearKeys: null as Error | null, processInfo: null as Error | null };
  const log: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const listCalls: Array<{ includeShells?: boolean } | undefined> = [];
  const events: ProviderEvent[] = [];
  const request: HerdrRequestFn = async (method, params) => {
    log.push({ method, params });
    if (method === "pane.process_info") {
      if (state.processInfo) throw state.processInfo;
      const snapshot = structuredClone(state.process);
      if (state.holdInfo && ++state.holdInfo.seen === state.holdInfo.nth) await state.holdInfo.promise;
      return { type: "pane_process_info", process_info: snapshot };
    }
    if (method === "pane.read" && state.holdRead) await state.holdRead;
    if (method === "pane.read") return { type: "pane_read", read: { pane_id: "pane-1", text: "$ " } };
    if (method === "pane.send_text" && state.sendText) throw state.sendText;
    if (method === "pane.send_keys") {
      const keys = (params?.keys ?? []) as string[];
      if (keys.includes("enter") && state.sendKeys) throw state.sendKeys;
      if (keys.includes("ctrl+u") && state.clearKeys) throw state.clearKeys;
    }
    return { type: "ok" };
  };
  const binding = bindingOf(shellPane(), genericAdapter, null, options.allowShell ? { allowShell: true } : {});
  const session = new HerdrHarnessSession("s", binding, {
    adapter: genericAdapter,
    listAgents: async (_signal, listOptions) => { listCalls.push(listOptions); return listOptions?.includeShells ? [shellPane()] : []; },
    request,
    subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }),
    emit: (event) => events.push(event),
    shellAllowed: async () => state.setting,
    shellRevoked: () => options.revoked === true,
  });
  sessions.push(session);
  await session.open({ cwd: "/work", env: options.env ?? {}, mcpServers: {}, settings: {}, persist: true }, "skip");
  await session.live.reconcile();
  const count = (method: string) => log.filter((entry) => entry.method === method).length;
  const writes = () => log.filter((entry) => entry.method === "pane.send_text" || entry.method === "pane.send_keys");
  const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms); };
  return { session, state, log, events, listCalls, count, writes, advance };
}
const noticeTitles = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.notice" ? [e.notice.title] : []);
const promptResults = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.prompt_result" ? [`${e.clientMessageId}:${e.result.type}`] : []);
const turnStates = (events: ProviderEvent[]) => events.flatMap((e) => e.type === "session.turn" ? [e.state] : []);

describe("shell opt-in: the flag", () => {
  it("without the flag a shell pane behaves as before: not listed, frozen at open, nothing is ever typed", async () => {
    const { session, listCalls, writes, events } = await world({ allowShell: false });
    expect(session.state.outcome).toBe("readonly");
    expect(listCalls.every((call) => call === undefined)).toBe(true); // `agent.list` only; shells were never asked for
    await session.prompt(prompt("p1", "rm -rf nothing"));
    expect(promptResults(events)).toEqual(["p1:failed"]);
    expect(writes()).toEqual([]);
    expect(noticeTitles(events)).not.toContain("Shell input is on");
  });

  it("with the flag the idle shell is bound, the notice shows at open, and the flag round-trips through persistence", async () => {
    const { session, events, listCalls } = await world({ allowShell: true });
    expect(session.state.outcome).toBe("active");
    expect(listCalls.every((call) => call?.includeShells === true)).toBe(true);
    expect(noticeTitles(events)).toContain("Shell input is on");
    expect(events.some((e) => e.type === "session.notice" && e.notice.description === "Prompt text runs as shell commands.")).toBe(true);
    const persisted = persistenceOf(session.state.binding);
    expect(persisted.data).toMatchObject({ allowShell: true, occupant: { pid: SHELL_PID, shell: true } });
    const reparsed = parseBinding(persisted, genericAdapter);
    expect(reparsed.allowShell).toBe(true);
    expect(reparsed.occupant?.shell).toBe(true);
    expect(Object.keys(persistenceOf(bindingOf(shellPane(), genericAdapter, null)).data as object)).not.toContain("allowShell");
  });

  it("the kill switch freezes a shell conversation and nothing is typed afterwards", async () => {
    const { session, writes, events } = await world({ allowShell: true });
    expect(session.setAllowShell(false)).toEqual({ applied: true });
    await session.live.reconcile();
    expect(session.state.outcome).toBe("readonly");
    expect(session.state.binding.allowShell).toBeUndefined();
    await session.prompt(prompt("p1"));
    expect(promptResults(events)).toEqual(["p1:failed"]);
    expect(writes()).toEqual([]);
  });

  it("refuses to turn shell input on for a conversation bound to an agent", async () => {
    const agent = shellPane({ agent: "grok", agent_status: "idle" });
    const events: ProviderEvent[] = [];
    const session = new HerdrHarnessSession("s", bindingOf(agent, genericAdapter, null), {
      adapter: genericAdapter, listAgents: async () => [agent],
      request: async (method) => method === "pane.process_info"
        ? { type: "pane_process_info", process_info: process_(300, "grok", { shell_pid: SHELL_PID }) }
        : { type: "pane_read", read: { pane_id: "pane-1", text: "" } },
      subscribe: async () => ({ [Symbol.asyncIterator]: async function* () {}, close() {} }), emit: (event) => events.push(event),
    });
    sessions.push(session);
    await session.open({ cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true }, "skip");
    expect(session.state.outcome).toBe("active");
    expect(() => session.setAllowShell(true)).toThrow(/bound to an agent/);
  });
});

describe("shell opt-in: admission and turns", () => {
  it("types the line, then presses Enter, and reminds that the text runs as commands", async () => {
    const { session, writes, events } = await world({ allowShell: true });
    await session.prompt(prompt("p1", "ls -la"));
    expect(promptResults(events)).toEqual(["p1:turn"]);
    expect(writes()).toEqual([
      { method: "pane.send_keys", params: { pane_id: "pane-1", keys: ["ctrl+e", "ctrl+u"] } },
      { method: "pane.send_text", params: { pane_id: "pane-1", text: "ls -la" } },
      { method: "pane.send_keys", params: { pane_id: "pane-1", keys: ["enter"] } },
    ]);
    expect(noticeTitles(events)).toContain("Prompt text runs as shell commands.");
  });

  it("admits only while the shell itself holds the foreground: a running child blocks, and so does a turn in flight", async () => {
    const { session, state, writes, events } = await world({ allowShell: true });
    state.process = busy();
    await session.live.reconcile();
    await session.prompt(prompt("p1"));
    expect(promptResults(events)).toEqual(["p1:failed"]);
    expect(writes()).toEqual([]);
    state.process = idle();
    await session.live.reconcile();
    await session.prompt(prompt("p2"));
    state.process = busy();
    await session.live.reconcile();
    await session.prompt(prompt("p3")); // the command is running: rejected, nothing typed into its stdin
    expect(promptResults(events)).toEqual(["p1:failed", "p2:turn", "p3:failed"]);
    expect(writes().filter((w) => w.method === "pane.send_text")).toHaveLength(1);
  });

  it("the turn ends when the foreground returns to the shell", async () => {
    const { session, state, events } = await world({ allowShell: true });
    await session.prompt(prompt("p1", "sleep 5"));
    state.process = busy();
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started"]);
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started"]); // still running
    state.process = idle();
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started", "completed"]);
    expect(noticeTitles(events)).not.toContain("Turn ended with no activity observed");
  });

  it("a command that finished between polls ends the turn once the shell has stayed idle, without the agent-style notice", async () => {
    const { session, events, advance } = await world({ allowShell: true });
    await session.prompt(prompt("p1", "true"));
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started"]);
    advance(1_600);
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started", "completed"]);
    expect(noticeTitles(events)).not.toContain("Turn ended with no activity observed");
  });

  it("an unreadable process lookup is unknown: new prompts are refused and a running turn is not ended or failed", async () => {
    const { session, state, events, writes, advance } = await world({ allowShell: true });
    await session.prompt(prompt("p1", "sleep 5"));
    state.process = busy();
    await session.live.reconcile();
    state.processInfo = new Error("herdr unreachable");
    await session.live.reconcile();
    advance(5_000);
    await session.live.reconcile();
    expect(turnStates(events)).toEqual(["started"]);
    expect(session.state.outcome).toBe("active");
    await session.prompt(prompt("p2"));
    expect(promptResults(events)).toEqual(["p1:turn", "p2:failed"]);
    expect(writes().filter((w) => w.method === "pane.send_text")).toHaveLength(1);
  });
});

describe("shell opt-in: identity", () => {
  it.each([
    ["the shell process is replaced by another pid", () => process_(300, "zsh", { shell_pid: 300 })],
    ["the shell execs another program", () => process_(SHELL_PID, "vim")],
    ["the shell has exited", () => process_(null, "zsh", { shell_pid: null })],
  ])("freezes when %s, and types nothing", async (_name, replacement) => {
    const { session, state, writes, events } = await world({ allowShell: true });
    state.process = replacement();
    await session.live.reconcile();
    expect(session.state.outcome).toBe("readonly");
    expect(noticeTitles(events)).toContain("The bound shell was replaced");
    await session.prompt(prompt("p1"));
    expect(writes()).toEqual([]);
  });

  it("freezes when the same pid has a different start time", async () => {
    const { session, writes } = await world({ allowShell: true });
    psId.mockImplementation(async (pid) => `${pid}@Sun Nov  1 09:00:00 2026`);
    await session.live.reconcile();
    expect(session.state.outcome).toBe("readonly");
    await session.prompt(prompt("p1"));
    expect(writes()).toEqual([]);
  });

  it("a ps failure is unknown, not a replacement: the prompt is refused and the chat recovers", async () => {
    const { session, events, writes } = await world({ allowShell: true });
    psId.mockRejectedValue(new Error("ps timed out"));
    await session.live.reconcile();
    expect(session.state.outcome).toBe("active");
    await session.prompt(prompt("p1"));
    expect(promptResults(events)).toEqual(["p1:failed"]);
    expect(writes()).toEqual([]);
    psId.mockImplementation(async (pid) => `${pid}@Sat Oct 31 00:33:57 2026`);
    await session.live.reconcile();
    await session.prompt(prompt("p2"));
    expect(promptResults(events)).toEqual(["p1:failed", "p2:turn"]);
  });

  it("never types into a non-shell occupant: a program that took the foreground in between is checked right before the write", async () => {
    const { session, state, events, writes } = await world({ allowShell: true });
    // Admission saw an idle shell; by the time of the write another program holds the pane.
    let reads = 0;
    const real = state.process;
    Object.defineProperty(state, "process", { get: () => (++reads <= 1 ? real : process_(SHELL_PID, "vim")), set: () => {} });
    await session.prompt(prompt("p1"));
    expect(promptResults(events)).toEqual(["p1:failed"]);
    expect(writes()).toEqual([]);
  });
});

describe("shell opt-in: submission", () => {
  it.each([["a newline", "ls\nrm -rf x"], ["an escape", "ls \u001b[A"], ["a carriage return", "ls\rrm x"], ["a tab", "ls\tfoo"]])("refuses text with %s: one prompt is one line, and nothing is written", async (_name, text) => {
    const { session, writes, events } = await world({ allowShell: true });
    await session.prompt(prompt("p1", text));
    expect(promptResults(events)).toEqual(["p1:failed"]);
    expect(writes()).toEqual([]);
    await session.prompt(prompt("p2", "echo ok")); // the refusal does not poison the binding
    expect(promptResults(events)).toEqual(["p1:failed", "p2:turn"]);
  });

  it("an error between the typed text and Enter is uncertain, and neither is ever sent again", async () => {
    const { session, state, count, events } = await world({ allowShell: true });
    state.sendKeys = new Error("request timed out");
    await session.prompt(prompt("p1"));
    expect(promptResults(events)).toEqual(["p1:turn"]);
    expect(noticeTitles(events)).toContain("Prompt delivery is uncertain");
    state.sendKeys = null;
    await session.live.reconcile();
    await session.prompt(prompt("p2", "again"));
    expect(promptResults(events)).toEqual(["p1:turn", "p2:failed"]);
    expect(count("pane.send_text")).toBe(1);
    expect(count("pane.send_keys")).toBe(2); // clear line, then the Enter that failed
  });

  it("an error typing the text is uncertain too, unless Herdr proved nothing was written", async () => {
    const unknown = await world({ allowShell: true });
    unknown.state.sendText = new Error("socket closed");
    await unknown.session.prompt(prompt("p1"));
    expect(promptResults(unknown.events)).toEqual(["p1:turn"]);
    expect(unknown.log.filter((entry) => entry.method === "pane.send_keys" && (entry.params?.keys as string[]).includes("enter"))).toEqual([]);
    const proven = await world({ allowShell: true });
    proven.state.sendText = new HerdrError("pane_not_found", "no such pane");
    await proven.session.prompt(prompt("p1"));
    expect(promptResults(proven.events)).toEqual(["p1:failed"]);
  });
});

describe("shell opt-in: Stop", () => {
  it("sends Ctrl+C only while a child holds the foreground", async () => {
    const { session, state, writes } = await world({ allowShell: true });
    await session.prompt(prompt("p1", "sleep 100"));
    state.process = busy();
    await session.live.reconcile();
    const before = writes().length;
    await session.interrupt("stop-1");
    expect(writes().slice(before)).toEqual([{ method: "pane.send_keys", params: { pane_id: "pane-1", keys: ["ctrl+c"] } }]);
  });

  it("sends nothing when the shell is idle, whether the turn is still open or its delivery was uncertain", async () => {
    const open = await world({ allowShell: true });
    await open.session.prompt(prompt("p1", "true"));
    const before = open.writes().length;
    await open.session.interrupt("stop-1"); // turn open, shell back at its prompt
    expect(open.writes()).toHaveLength(before);
    const uncertain = await world({ allowShell: true });
    uncertain.state.sendKeys = new Error("timeout");
    await uncertain.session.prompt(prompt("p1"));
    const count = uncertain.writes().length;
    await uncertain.session.interrupt("stop-1");
    expect(uncertain.writes()).toHaveLength(count);
    expect(open.events.some((e) => e.type === "request.completed" && e.requestId === "stop-1")).toBe(true);
  });
});

describe("shell panes in the listing", () => {
  const paneRow = (id: string, agent: string | null) => ({ pane_id: id, terminal_id: `t-${id}`, workspace_id: "w", tab_id: "t", focused: false, agent, agent_status: "unknown", revision: 1, cwd: "/work" });
  const request = (log: string[]): HerdrRequestFn => async (method) => {
    log.push(method);
    if (method === "agent.list") return { type: "agent_list", agents: [shellPane({ terminal_id: "t-a", pane_id: "a", agent: "grok", agent_status: "idle" })] };
    return { type: "pane_list", panes: [paneRow("a", "grok"), paneRow("s", null)] };
  };

  it("the default listing is agent.list only, exactly as before", async () => {
    const log: string[] = [];
    const agents = await listPaneTargets(request(log));
    expect(log).toEqual(["agent.list"]);
    expect(agents.map((agent) => agent.terminal_id)).toEqual(["t-a"]);
  });

  it("includeShells adds plain shell panes, labelled as running commands, never an agent twice", async () => {
    const log: string[] = [];
    const agents = await listPaneTargets(request(log), { includeShells: true });
    expect(agents.map((agent) => agent.terminal_id)).toEqual(["t-a", "t-s"]);
    expect(agents[1]).toMatchObject({ agent: null, agent_status: "unknown", display_agent: expect.stringContaining("runs as commands") });
  });
});

describe("herdr.chat.allow-shell", () => {
  async function rpcWorld() {
    const openSessions = new OpenSessions();
    const handlers = new Map<string, (input: never, context: never) => Promise<unknown>>();
    registerManagementRpcs({ handle: ((rpc: { name: string }, fn: never) => { handlers.set(rpc.name, fn); }) as never },
      { readTarget: async () => { throw new Error("unused"); }, shellAllowed: async () => true, ensureReady: async () => { throw new Error("unused"); }, harnesses: [genericAdapter], openSessions,
        companionStatus: async () => ({ state: "current", path: "/x" }) });
    const w = await world({ allowShell: true, env: { PASEO_AGENT_ID: "agent-9" } });
    openSessions.add(w.session);
    const call = (input: { agentId: string; enabled: boolean }) => handlers.get(herdrChatAllowShellRpc.name)!(input as never, {} as never);
    return { ...w, call };
  }

  it("turns the flag off for the open conversation, persists it, and the conversation freezes", async () => {
    const { session, call, events, writes } = await rpcWorld();
    await expect(call({ agentId: "agent-9", enabled: false })).resolves.toEqual({ enabled: false, applied: true });
    await session.live.reconcile();
    expect(session.state.outcome).toBe("readonly");
    const persistence = events.filter((e) => e.type === "session.persistence").at(-1);
    expect(persistence && "persistence" in persistence && (persistence.persistence.data as Record<string, unknown>).allowShell).toBeUndefined();
    expect(writes()).toEqual([]);
  });

  it("errors for a conversation that is not open", async () => {
    const { call } = await rpcWorld();
    await expect(call({ agentId: "nobody", enabled: true })).rejects.toThrow(/not open/);
  });
});

const writeCalls = (log: Array<{ method: string; params?: Record<string, unknown> }>) => log.filter((entry) => entry.method === "pane.send_text");
const enterKeys = (log: Array<{ method: string; params?: Record<string, unknown> }>) => log.filter((entry) => entry.method === "pane.send_keys" && (entry.params?.keys as string[]).includes("enter"));
const deferred = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; };
const withForeground = (processes: Array<{ pid: number; name: string; argv?: string[]; argv0?: string }>, group = SHELL_PID): PaneProcessInfo =>
  ({ pane_id: "pane-1", shell_pid: SHELL_PID, foreground_process_group_id: group, tty: "/dev/ttys001", foreground_processes: processes });

describe("review fix P1-1: multiplexers and login are not an idle shell", () => {
  it.each(["tmux", "screen", "zellij", "login"])("%s at the shell pid freezes the binding at open and types nothing", async (name) => {
    const { session, writes, events } = await world({ allowShell: true, process: process_(SHELL_PID, name) });
    expect(session.state.outcome).toBe("readonly");
    expect(session.state.binding.occupant).toBeUndefined();
    await session.prompt(prompt("p1"));
    expect(promptResults(events)).toEqual(["p1:failed"]);
    expect(writes()).toEqual([]);
  });

  it.each(["tmux", "screen", "zellij", "login"])("a shell that execs %s mid-conversation freezes, and the next prompt writes nothing", async (name) => {
    const { session, state, writes, events } = await world({ allowShell: true });
    state.process = process_(SHELL_PID, name);
    await session.live.reconcile();
    expect(session.state.outcome).toBe("readonly");
    expect(noticeTitles(events)).toContain("The bound shell was replaced");
    await session.prompt(prompt("p1"));
    expect(writes()).toEqual([]);
  });
});

describe("review fix P1-2: an unconfirmed delivery never lets the next prompt run on a dirty line", () => {
  it("an Enter error, then Stop, then a second prompt writes nothing", async () => {
    const { session, state, log, events } = await world({ allowShell: true });
    state.sendKeys = new Error("request timed out");
    await session.prompt(prompt("p1", "ls /tmp"));
    state.sendKeys = null;
    await session.interrupt("stop-1");
    await session.live.reconcile();
    const before = log.length;
    await session.prompt(prompt("p2", "rm -rf build"));
    expect(promptResults(events)).toEqual(["p1:turn", "p2:failed"]);
    expect(log.slice(before).filter((entry) => entry.method.startsWith("pane.send"))).toEqual([]);
    expect(writeCalls(log)).toHaveLength(1);
    expect(enterKeys(log)).toHaveLength(1);
  });

  it("the 15 s idle settle does not release it either; acknowledging does, once", async () => {
    const { session, state, log, events, advance } = await world({ allowShell: true });
    state.sendKeys = new Error("request timed out");
    await session.prompt(prompt("p1", "ls /tmp"));
    state.sendKeys = null;
    for (let i = 0; i < 4; i++) { advance(5_000); await session.live.reconcile(); }
    await session.prompt(prompt("p2", "echo two"));
    expect(promptResults(events)).toEqual(["p1:turn", "p2:failed"]);
    expect(writeCalls(log)).toHaveLength(1);
    expect(session.acknowledgeShell()).toBe(true);
    expect(session.acknowledgeShell()).toBe(false);
    await session.prompt(prompt("p3", "echo three"));
    expect(promptResults(events)).toEqual(["p1:turn", "p2:failed", "p3:turn"]);
    expect(writeCalls(log).map((entry) => entry.params?.text)).toEqual(["ls /tmp", "echo three"]);
  });

  it("an error typing the text blocks the next prompt too", async () => {
    const { session, state, log, events } = await world({ allowShell: true });
    state.sendText = new Error("socket closed");
    await session.prompt(prompt("p1", "ls"));
    state.sendText = null;
    await session.interrupt("stop-1");
    await session.prompt(prompt("p2", "pwd"));
    expect(promptResults(events)).toEqual(["p1:turn", "p2:failed"]);
    expect(writeCalls(log)).toHaveLength(1);
  });

  it("a reopened conversation is a new session: the block does not outlive it", async () => {
    const first = await world({ allowShell: true });
    first.state.sendKeys = new Error("timeout");
    await first.session.prompt(prompt("p1"));
    expect(first.session.shellUncertain).toBe(true);
    const second = await world({ allowShell: true });
    expect(second.session.shellUncertain).toBe(false);
  });

  it("clears the command line before typing, and a failed clear types nothing and blocks nothing", async () => {
    const { session, state, log, events } = await world({ allowShell: true });
    await session.prompt(prompt("p1", "ls"));
    const names = log.filter((entry) => entry.method.startsWith("pane.send")).map((entry) => entry.method === "pane.send_text" ? "text" : (entry.params?.keys as string[]).join("+"));
    expect(names).toEqual(["ctrl+e+ctrl+u", "text", "enter"]);
    await session.live.reconcile();
    await session.live.reconcile();
    state.clearKeys = new Error("timeout");
    const before = writeCalls(log).length;
    await session.prompt(prompt("p2", "pwd"));
    expect(promptResults(events).at(-1)).toBe("p2:failed");
    expect(writeCalls(log)).toHaveLength(before);
    expect(session.shellUncertain).toBe(false);
  });
});

describe("review fix P2-1: idle means the foreground group holds exactly the interactive shell", () => {
  it("another process in the shell's own group (job control off) is busy, not idle", async () => {
    const { session, state, writes, events } = await world({ allowShell: true });
    state.process = withForeground([{ pid: SHELL_PID, name: "bash" }, { pid: 201, name: "sudo" }]);
    await session.live.reconcile();
    expect(session.state.outcome).toBe("active");
    await session.prompt(prompt("p1"));
    expect(promptResults(events)).toEqual(["p1:failed"]);
    expect(writes()).toEqual([]);
  });

  it("a shell running a script operand is not an idle shell, but login and interactive flags are", async () => {
    const script = await world({ allowShell: true });
    script.state.process = withForeground([{ pid: SHELL_PID, name: "bash", argv: ["bash", "deploy.sh"] }]);
    await script.session.live.reconcile();
    expect(script.session.state.outcome).toBe("readonly");
    const dashC = await world({ allowShell: true, process: withForeground([{ pid: SHELL_PID, name: "sh", argv: ["sh", "-c", "sleep 9"] }]) });
    expect(dashC.session.state.outcome).toBe("readonly");
    const interactive = await world({ allowShell: true, process: withForeground([{ pid: SHELL_PID, name: "zsh", argv: ["-zsh"] }]) });
    expect(interactive.session.state.outcome).toBe("active");
    const flags = await world({ allowShell: true, process: withForeground([{ pid: SHELL_PID, name: "bash", argv: ["bash", "--login", "-i"] }]) });
    expect(flags.session.state.outcome).toBe("active");
  });

  it("the pre-write re-check also refuses a group that gained a member after admission", async () => {
    const { session, state, events, writes } = await world({ allowShell: true });
    let reads = 0;
    const real = state.process;
    Object.defineProperty(state, "process", { get: () => (++reads <= 1 ? real : withForeground([{ pid: SHELL_PID, name: "zsh" }, { pid: 201, name: "vim" }])), set: () => {} });
    await session.prompt(prompt("p1"));
    expect(promptResults(events)).toEqual(["p1:failed"]);
    expect(writes()).toEqual([]);
  });

  it("a pre-write re-check that sees another shell pid writes nothing", async () => {
    const { session, state, events, writes } = await world({ allowShell: true });
    let reads = 0;
    const real = state.process;
    Object.defineProperty(state, "process", { get: () => (++reads <= 1 ? real : process_(300, "zsh", { shell_pid: 300 })), set: () => {} });
    await session.prompt(prompt("p1"));
    expect(promptResults(events)).toEqual(["p1:failed"]);
    expect(writes()).toEqual([]);
  });
});

describe("review fix P2-2: the kill switch stops a prompt that is being delivered", () => {
  it("turned off while the transcript read is pending: nothing is written", async () => {
    const { session, state, writes, events } = await world({ allowShell: true });
    const hold = deferred();
    state.holdRead = hold.promise;
    const running = session.prompt(prompt("p1"));
    await vi.waitFor(() => expect(session.state.admitting).toBe(true));
    expect(session.setAllowShell(false)).toEqual({ applied: true });
    expect(session.state.outcome).toBe("readonly"); // frozen synchronously, not at the next poll
    hold.release();
    await running;
    expect(writes()).toEqual([]);
    expect(promptResults(events)).not.toContain("p1:turn");
  });

  it("turned off while the pre-write process lookup is pending: nothing is written", async () => {
    const { session, state, writes } = await world({ allowShell: true });
    const hold = deferred();
    state.holdInfo = { nth: 2, promise: hold.promise, seen: 0 };
    const running = session.prompt(prompt("p1"));
    await vi.waitFor(() => expect(state.holdInfo?.seen).toBeGreaterThanOrEqual(2));
    session.setAllowShell(false);
    hold.release();
    await running;
    expect(writes()).toEqual([]);
  });

  it("the plugin setting turned off while the pre-write lookup is pending: nothing is written", async () => {
    const { session, state, writes } = await world({ allowShell: true });
    const hold = deferred();
    state.holdInfo = { nth: 2, promise: hold.promise, seen: 0 };
    const running = session.prompt(prompt("p1"));
    await vi.waitFor(() => expect(state.holdInfo?.seen).toBeGreaterThanOrEqual(2));
    state.setting = false;
    hold.release();
    await running;
    expect(writes()).toEqual([]);
    expect(session.state.outcome).toBe("readonly");
  });
});

describe("review fix P2-3: the plugin setting is the global gate", () => {
  it("with the setting off a persisted flagged binding is treated as flag-off: frozen, flag forgotten and persisted, nothing typed", async () => {
    const { session, writes, events, listCalls } = await world({ allowShell: true, setting: false });
    expect(session.state.outcome).toBe("readonly");
    expect(session.state.binding.allowShell).toBeUndefined();
    expect(listCalls.every((call) => call === undefined)).toBe(true); // shells are not even listed
    const persisted = events.filter((e) => e.type === "session.persistence").at(-1);
    expect(persisted && "persistence" in persisted && (persisted.persistence.data as Record<string, unknown>).allowShell).toBeUndefined();
    await session.prompt(prompt("p1"));
    expect(writes()).toEqual([]);
  });

  it("switching the setting off freezes an open conversation at the next check, and switching it on again does not re-arm", async () => {
    const { session, state, writes } = await world({ allowShell: true });
    state.setting = false;
    await session.live.reconcile();
    expect(session.state.outcome).toBe("readonly");
    state.setting = true;
    await session.live.reconcile();
    await session.prompt(prompt("p1"));
    expect(session.state.binding.allowShell).toBeUndefined();
    expect(writes()).toEqual([]);
  });

  it("a revocation made while the chat was closed clears the flag at the next open", async () => {
    const { session, writes } = await world({ allowShell: true, revoked: true, env: { PASEO_AGENT_ID: "agent-r" } });
    expect(session.state.outcome).toBe("readonly");
    expect(session.state.binding.allowShell).toBeUndefined();
    await session.prompt(prompt("p1"));
    expect(writes()).toEqual([]);
  });

  async function rpcOf(setting: boolean) {
    const openSessions = new OpenSessions();
    const handlers = new Map<string, (input: never, context: never) => Promise<unknown>>();
    registerManagementRpcs({ handle: ((rpc: { name: string }, fn: never) => { handlers.set(rpc.name, fn); }) as never },
      { readTarget: async () => { throw new Error("unused"); }, ensureReady: async () => { throw new Error("unused"); }, harnesses: [genericAdapter], openSessions, shellAllowed: async () => setting,
        companionStatus: async () => ({ state: "current", path: "/x" }) });
    return { openSessions, call: (name: string, input: Record<string, unknown>) => handlers.get(name)!(input as never, {} as never) };
  }

  it("herdr.chat.allow-shell enabled:true is refused while the setting is off", async () => {
    const { call } = await rpcOf(false);
    await expect(call(herdrChatAllowShellRpc.name, { agentId: "a", enabled: true })).rejects.toThrow(/turned off in the Herdr plugin settings/);
  });

  it("enabled:false for a chat that is not open records a revocation instead of failing", async () => {
    const { call, openSessions } = await rpcOf(true);
    await expect(call(herdrChatAllowShellRpc.name, { agentId: "closed-1", enabled: false })).resolves.toEqual({ enabled: false, applied: false });
    expect(openSessions.isRevoked("closed-1")).toBe(true);
  });

  it("herdr.chat.shell-acknowledge releases an unconfirmed delivery on the open conversation", async () => {
    const { call, openSessions } = await rpcOf(true);
    const w = await world({ allowShell: true, env: { PASEO_AGENT_ID: "agent-7" } });
    openSessions.add(w.session);
    w.session.markShellUncertain();
    await expect(call(herdrChatShellAcknowledgeRpc.name, { agentId: "agent-7" })).resolves.toEqual({ acknowledged: true });
    expect(w.session.shellUncertain).toBe(false);
    await expect(call(herdrChatShellAcknowledgeRpc.name, { agentId: "nobody" })).rejects.toThrow(/not open/);
  });
});

describe("review fixes P3", () => {
  it("1: a flagged binding whose shell is busy at open freezes instead of binding the foreground program", async () => {
    const { session, events, writes } = await world({ allowShell: true, process: process_(200, "vim") });
    expect(session.state.outcome).toBe("readonly");
    expect(session.state.binding.occupant).toBeUndefined();
    expect(noticeTitles(events)).toContain("The shell is not at an idle prompt");
    await session.prompt(prompt("p1"));
    expect(writes()).toEqual([]);
  });

  it("2: a program that merely names itself zsh (argv0) is not an idle shell", async () => {
    const { session, state, writes } = await world({ allowShell: true });
    state.process = withForeground([{ pid: SHELL_PID, name: "vim", argv0: "zsh" }]);
    await session.live.reconcile();
    expect(session.state.outcome).toBe("readonly");
    await session.prompt(prompt("p1"));
    expect(writes()).toEqual([]);
  });

  it.each([
    ["1000 bytes", "a".repeat(1000), "turn"],
    ["1001 bytes", "a".repeat(1001), "failed"],
    ["334 three-byte characters (1002 bytes)", "\u20ac".repeat(334), "failed"],
  ])("3: %s", async (_name, text, result) => {
    const { session, events, writes } = await world({ allowShell: true });
    await session.prompt(prompt("p1", text));
    expect(promptResults(events)).toEqual([`p1:${result}`]);
    if (result === "failed") expect(writes()).toEqual([]);
  });

  it.each([["DEL", "ls\u007f"], ["a C1 control", "ls\u0085x"], ["a line separator", "ls\u2028x"], ["a paragraph separator", "ls\u2029x"], ["NUL", "ls\u0000"]])("refuses %s", async (_name, text) => {
    const { session, writes, events } = await world({ allowShell: true });
    await session.prompt(prompt("p1", text));
    expect(promptResults(events)).toEqual(["p1:failed"]);
    expect(writes()).toEqual([]);
  });

  it("4: a validation that finishes after a newer one does not move the working/idle tracker", async () => {
    const { session, state } = await world({ allowShell: true });
    const track = () => structuredClone((session as unknown as { shellTrack: unknown }).shellTrack);
    const settled = track();
    const hold = deferred();
    state.process = busy();
    state.holdInfo = { nth: 1, promise: hold.promise, seen: 0 };
    const older = session.validateAgent();
    await vi.waitFor(() => expect(state.holdInfo?.seen).toBe(1));
    state.process = idle();
    state.holdInfo = null;
    await session.validateAgent();
    expect(track()).toEqual(settled);
    hold.release();
    await older;
    expect(track()).toEqual(settled);
  });

  it("5: an unreadable process lookup reports the tracker's own counters, never the listing's", async () => {
    const { session, state } = await world({ allowShell: true });
    await session.prompt(prompt("p1", "sleep 5"));
    state.process = busy();
    await session.live.reconcile();
    state.process = idle();
    await session.live.reconcile();
    const track = (session as unknown as { shellTrack: { seq: number; completion: number } }).shellTrack;
    expect(track.seq).toBeGreaterThan(0);
    state.processInfo = new Error("herdr unreachable");
    const unknown = await session.validateAgent();
    expect(unknown).toMatchObject({ agent_status: "unknown", state_change_seq: track.seq, completion_seq: track.completion });
  });

  it("8: a delivered shell prompt appears as a user row in the conversation", async () => {
    const { session } = await world({ allowShell: true });
    await session.prompt(prompt("p1", "ls -la"));
    const snapshot = await session.state.reader!.snapshot();
    expect(snapshot.items.filter((item) => item.type === "user_message").map((item) => item.type === "user_message" ? item.text : null)).toEqual(["ls -la"]);
  });

  it("8: an unconfirmed delivery leaves no user row", async () => {
    const { session, state } = await world({ allowShell: true });
    state.sendKeys = new Error("timeout");
    await session.prompt(prompt("p1", "ls -la"));
    const snapshot = await session.state.reader!.snapshot();
    expect(snapshot.items.filter((item) => item.type === "user_message")).toEqual([]);
  });
});
