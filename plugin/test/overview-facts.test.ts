import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptSummaryCache } from "../server/activity.js";
import { registerManagementRpcs, type ManagementDeps } from "../server/rpc.js";
import { ompAdapter } from "../server/harness/omp/adapter.js";
import { herdrOverviewRpc, type HerdrTarget } from "../shared/rpc.js";
import { FakeHerdr } from "./fake-herdr.js";

let fake: FakeHerdr;
let dir: string;
const stops: (() => void)[] = [];
beforeEach(async () => { fake = await FakeHerdr.create(); dir = await mkdtemp(join(tmpdir(), "facts-test-")); });
afterEach(async () => { for (const stop of stops.splice(0)) stop(); await fake.close(); await rm(dir, { recursive: true, force: true }); });

type Handler = (input: unknown, ctx: unknown) => Promise<unknown> | unknown;
function setup(overrides: Partial<ManagementDeps> = {}) {
  const handlers = new Map<string, Handler>();
  const target: HerdrTarget = { socketPath: fake.socketPath, herdrSession: "work", source: "settingSession", autoStart: false, autoStartDisabledReason: null };
  const stop = registerManagementRpcs({ handle: ((contract: { name: string }, handler: Handler) => { handlers.set(contract.name, handler); }) as never }, {
    readTarget: async () => ({ target, ompEnabled: true }),
    ensureReady: async (x) => ({ target: x, version: "0.9.3", autoStarted: false }),
    harnesses: [ompAdapter],
    sessionRoots: () => [dir],
    companionStatus: async () => ({ state: "current", path: "/fake/ext/paseo4herdr-input.ts" }),
    ...overrides,
  });
  stops.push(stop);
  const overview = async (paseo: unknown = noChats) => {
    const result = herdrOverviewRpc.output.parse(await handlers.get("herdr.overview")!({}, { paseo }));
    return result;
  };
  return { overview, stop };
}
const noChats = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }) } };

const pane = (id: string, extra: object = {}) => ({ pane_id: id, terminal_id: `t-${id}`, workspace_id: "w1", tab_id: "tab1", focused: false, cwd: "/a", agent_status: "idle", revision: 1, ...extra });
const agent = (id: string, extra: object = {}) => ({ terminal_id: `t-${id}`, name: null, agent: "omp", agent_status: "idle", workspace_id: "w1", tab_id: "tab1", pane_id: id, focused: false, cwd: "/a", revision: 1, state_change_seq: 7, ...extra });
const sessionOf = (path: string) => ({ agent_session: { source: "omp", agent: "omp", kind: "path", value: path } });

function seed(panes: object[], agents: object[]) {
  fake.reply("workspace.list", { type: "workspace_list", workspaces: [{ workspace_id: "w1", number: 1, label: "proj", focused: true, agent_status: "idle" }] });
  fake.reply("tab.list", { type: "tab_list", tabs: [{ tab_id: "tab1", workspace_id: "w1", number: 1, label: "one", focused: true, agent_status: "idle" }] });
  fake.reply("pane.list", { type: "pane_list", panes });
  fake.reply("agent.list", { type: "agent_list", agents });
}
const writeSession = async (name: string, lines: object[]) => {
  const path = join(dir, name);
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
};
const agents = (result: Awaited<ReturnType<ReturnType<typeof setup>["overview"]>>) => result.workspaces[0]!.tabs[0]!.agents;

describe("overview facts", () => {
  it("numbers panes within their tab (Herdr's own number when it sends one) and sends the daemon clock", async () => {
    seed([pane("p1"), pane("p2", { number: 5 }), pane("p3")], [agent("p1"), agent("p2"), agent("p3")]);
    const { overview } = setup({ now: () => Date.parse("2026-11-12T12:00:00Z") });
    const result = await overview();
    expect(agents(result).map((a) => a.paneNumber)).toEqual([1, 5, 3]);
    expect(result.serverNow).toBe("2026-11-12T12:00:00.000Z");
    expect(result.statePollMs).toBeUndefined();
  });

  it("reports times, model and an Anthropic cache estimate from the session file; no state time without the loop", async () => {
    const path = await writeSession("a.jsonl", [
      { type: "session", timestamp: "2026-11-12T10:00:00.000Z" },
      { type: "message", timestamp: "2026-11-12T11:00:00.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-x" } },
      { type: "message", timestamp: "2026-11-12T11:01:00.000Z", message: { role: "toolResult" } },
    ]);
    seed([pane("p1")], [agent("p1", sessionOf(path))]);
    const [row] = agents(await setup().overview());
    expect(row).toMatchObject({
      paneNumber: 1, sessionStartedAt: "2026-11-12T10:00:00.000Z", lastAssistantAt: "2026-11-12T11:00:00.000Z", model: "anthropic/claude-x",
      lastActivitySource: "session-file", stateChangeSeq: 7, stateChangedAt: null, stateChangedExact: false,
      cache: { provider: "anthropic", anchorAt: "2026-11-12T11:01:00.000Z", ttlSec: 300, ttlKnown: false },
    });
    expect(row!.lastActivityAt).not.toBeNull();
  });

  it("a non-Anthropic model gets no cache estimate, and a missing session file gets no invented times", async () => {
    const path = await writeSession("b.jsonl", [
      { type: "session", timestamp: "2026-11-12T10:00:00.000Z" },
      { type: "message", timestamp: "2026-11-12T11:00:00.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-6.1-sol" } },
    ]);
    seed([pane("p1"), pane("p2")], [agent("p1", sessionOf(path)), agent("p2", sessionOf(join(dir, "missing.jsonl")))]);
    const [a, b] = agents(await setup().overview());
    expect(a).toMatchObject({ model: "openai-codex/gpt-6.1-sol", cache: null });
    expect(b).toMatchObject({ model: null, cache: null, lastActivityAt: null, lastActivitySource: null, sessionStartedAt: null });
  });

  it("the state loop stamps first sight as a lower bound, then an exact time on a change, and stops on request", async () => {
    seed([pane("p1")], [agent("p1", { agent_status: "working", state_change_seq: 3 })]);
    let clock = Date.parse("2026-11-12T12:00:00Z");
    const { overview, stop } = setup({ statePollMs: 10, now: () => clock });
    const first = await overview();
    expect(first.statePollMs).toBe(10);
    expect(agents(first)[0]).toMatchObject({ stateChangedAt: "2026-11-12T12:00:00.000Z", stateChangedExact: false });
    clock = Date.parse("2026-11-12T12:05:00Z");
    fake.reply("agent.list", { type: "agent_list", agents: [agent("p1", { agent_status: "blocked", state_change_seq: 4 })] });
    let row = agents(first)[0]!;
    for (let i = 0; i < 100 && !row.stateChangedExact; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      row = agents(await overview())[0]!;
    }
    expect(row).toMatchObject({ status: "blocked", stateChangedAt: "2026-11-12T12:05:00.000Z", stateChangedExact: true, stateChangeSeq: 4 });
    stop();
  });

  it("a status change shows an exact time at once, with no gap until the next sample", async () => {
    seed([pane("p1")], [agent("p1", { agent_status: "working", state_change_seq: 3 })]);
    let clock = Date.parse("2026-11-12T12:00:00Z");
    // A long poll interval: only the first sample runs; the overview itself keeps the stamp current.
    const { overview } = setup({ statePollMs: 3_600_000, now: () => clock });
    expect(agents(await overview())[0]).toMatchObject({ stateChangedAt: "2026-11-12T12:00:00.000Z", stateChangedExact: false });
    clock = Date.parse("2026-11-12T12:01:00Z");
    fake.reply("agent.list", { type: "agent_list", agents: [agent("p1", { agent_status: "idle", state_change_seq: 4 })] });
    expect(agents(await overview())[0]).toMatchObject({ stateChangedAt: "2026-11-12T12:01:00.000Z", stateChangedExact: true });
  });

  it("without the loop there is no state time at all", async () => {
    seed([pane("p1")], [agent("p1")]);
    expect(agents(await setup().overview())[0]).toMatchObject({ stateChangedAt: null, stateChangedExact: false });
  });

  it("a late overview call after stop does not restart the loop", async () => {
    seed([pane("p1")], [agent("p1")]);
    const { overview, stop } = setup({ statePollMs: 10 });
    await overview();
    stop();
    const before = fake.requestsFor("agent.list").length;
    await overview();
    await new Promise((resolve) => setTimeout(resolve, 80));
    // The overview's own agent.list is the only new one: no timer is sampling.
    expect(fake.requestsFor("agent.list").length - before).toBeLessThanOrEqual(1);
  });

  it("never reads a session path outside the harness's own session directory", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "elsewhere-"));
    try {
      const path = join(elsewhere, "a.jsonl");
      await writeFile(path, [JSON.stringify({ type: "session", timestamp: "2026-11-12T10:00:00.000Z" }), JSON.stringify({ type: "model_change", model: "anthropic/leak" })].join("\n") + "\n");
      seed([pane("p1")], [agent("p1", sessionOf(path))]);
      const transcripts = new TranscriptSummaryCache();
      // Default roots: OMP's sessions directory under PI_CODING_AGENT_DIR, which is not where the file is.
      const { overview } = setup({ sessionRoots: undefined, env: { PI_CODING_AGENT_DIR: join(dir, "agent") }, transcripts });
      expect(agents(await overview())[0]).toMatchObject({ model: null, cache: null, lastActivityAt: null, sessionStartedAt: null });
      expect(transcripts.reads).toBe(0);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("reads a session inside OMP's default sessions directory", async () => {
    const sessions = join(dir, "agent", "sessions", "proj");
    await mkdir(sessions, { recursive: true });
    const path = join(sessions, "a.jsonl");
    await writeFile(path, JSON.stringify({ type: "model_change", model: "anthropic/ok" }) + "\n");
    seed([pane("p1")], [agent("p1", sessionOf(path))]);
    const { overview } = setup({ sessionRoots: undefined, env: { PI_CODING_AGENT_DIR: join(dir, "agent") } });
    expect(agents(await overview())[0]).toMatchObject({ model: "anthropic/ok" });
  });

  it("another adapter's agent never gets a session read", async () => {
    const path = await writeSession("c.jsonl", [{ type: "model_change", model: "anthropic/x" }]);
    seed([pane("p1")], [agent("p1", { ...sessionOf(path), agent: "claude" })]);
    const { overview } = setup();
    expect(agents(await overview())[0]).toMatchObject({ model: null });
  });

  it("a session read that hangs does not stall the overview", async () => {
    seed([pane("p1")], [agent("p1", sessionOf(join(dir, "hung.jsonl")))]);
    const hung = { read: () => new Promise(() => undefined), reads: 0 } as unknown as TranscriptSummaryCache;
    const { overview } = setup({ transcripts: hung });
    const started = Date.now();
    const [row] = agents(await overview());
    expect(row).toMatchObject({ model: null, lastActivityAt: null, status: "idle" });
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
