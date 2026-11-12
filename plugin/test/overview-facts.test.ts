import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("a stamp that no longer matches Herdr's status is not reported", async () => {
    seed([pane("p1")], [agent("p1", { agent_status: "working", state_change_seq: 3 })]);
    // A long poll interval: only the first sample runs, so the stamp goes stale when the status moves.
    const { overview } = setup({ statePollMs: 3_600_000 });
    expect(agents(await overview())[0]!.stateChangedAt).not.toBeNull();
    fake.reply("agent.list", { type: "agent_list", agents: [agent("p1", { agent_status: "idle", state_change_seq: 4 })] });
    expect(agents(await overview())[0]).toMatchObject({ stateChangedAt: null, stateChangedExact: false });
  });
});
