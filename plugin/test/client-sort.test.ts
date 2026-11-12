import { describe, expect, it } from "vitest";
import { overviewAgentSchema, type OverviewAgent, type OverviewWorkspace } from "../shared/rpc.js";
import { comparator, defaultDir, dirLabel, flatAgents, groupAgents, normalizeView, pickField, sortAgents, toggleDir, flattenOverview, type SortField } from "../client/sort.js";

function agent(id: string, extra: Partial<OverviewAgent> = {}): OverviewAgent {
  return overviewAgentSchema.parse({
    terminalId: id, paneId: `p-${id}`, name: null, title: id, kind: "omp", harness: "OMP", provider: "herdr-omp", status: "idle",
    cwd: "/a", paseoAgentId: null, attachCommand: "x", attach: null, inputReady: null, canRestart: false, ...extra,
  });
}
const tab = (number: number, label: string, agents: OverviewAgent[]) => ({ tabId: `tab${number}-${label}`, number, label, focused: false, status: "idle" as const, agents });
const ws = (number: number, label: string, tabs: ReturnType<typeof tab>[]): OverviewWorkspace => ({ workspaceId: `w${number}`, number, label, focused: false, cwd: `/ws${number}`, status: "idle", tabs });

const iso = (m: number) => new Date(Date.UTC(2026, 10, 12, 12, m)).toISOString();
const ids = (items: { agent: OverviewAgent }[]) => items.map((x) => x.agent.terminalId);

const sample = [
  ws(2, "beta", [tab(1, "t", [agent("b1", { paneNumber: 1, lastActivityAt: iso(5), status: "blocked" })])]),
  ws(1, "alpha", [
    tab(1, "x", [agent("a1", { paneNumber: 1, lastActivityAt: iso(1), status: "working" }), agent("a2", { paneNumber: 2, lastActivityAt: null, status: "idle" })]),
    tab(2, "y", [agent("a3", { paneNumber: 1, lastActivityAt: iso(9), status: "done" })]),
  ]),
];

describe("view", () => {
  it("each field has a default direction: times newest first, cache soonest first, status most urgent first", () => {
    expect(defaultDir("lastActivity")).toBe("desc");
    expect(defaultDir("stateChanged")).toBe("desc");
    expect(defaultDir("sessionStarted")).toBe("desc");
    expect(defaultDir("cacheCold")).toBe("asc");
    expect(defaultDir("status")).toBe("asc");
    expect(defaultDir("title")).toBe("asc");
  });
  it("picking a field resets the direction", () => {
    const view = pickField({ field: "title", dir: "desc", grouped: false }, "lastActivity");
    expect(view).toEqual({ field: "lastActivity", dir: "desc", grouped: false });
    expect(pickField({ field: "lastActivity", dir: "asc", grouped: true }, "title").dir).toBe("asc");
    expect(toggleDir(view).dir).toBe("asc");
  });
  it("direction labels fit the field", () => {
    expect(dirLabel("lastActivity", "desc")).toBe("Newest first");
    expect(dirLabel("title", "asc")).toBe("A→Z");
    expect(dirLabel("title", "desc")).toBe("Z→A");
    expect(dirLabel("status", "asc")).toBe("Most urgent first");
    expect(dirLabel("cacheCold", "asc")).toBe("Soonest cold first");
  });
  it("normalizes stored values: unknown field falls back to Herdr order, missing direction to the default, grouped defaults on", () => {
    expect(normalizeView(undefined)).toEqual({ field: "herdr", dir: "asc", grouped: true });
    expect(normalizeView({ field: "nope", dir: "desc", grouped: false })).toEqual({ field: "herdr", dir: "desc", grouped: false });
    expect(normalizeView({ field: "lastActivity", dir: null })).toEqual({ field: "lastActivity", dir: "desc", grouped: true });
  });
});

describe("sorting", () => {
  const items = flattenOverview(sample);
  it("Herdr order is workspace, tab, pane", () => {
    expect(ids(sortAgents(items, "herdr", "asc"))).toEqual(["a1", "a2", "a3", "b1"]);
    expect(ids(sortAgents(items, "herdr", "desc"))).toEqual(["b1", "a3", "a2", "a1"]);
  });
  it("last activity newest first; unknown times last in both directions", () => {
    expect(ids(sortAgents(items, "lastActivity", "desc"))).toEqual(["a3", "b1", "a1", "a2"]);
    expect(ids(sortAgents(items, "lastActivity", "asc"))).toEqual(["a1", "b1", "a3", "a2"]);
  });
  it("status puts blocked first on the default direction", () => {
    expect(ids(sortAgents(items, "status", "asc"))).toEqual(["b1", "a1", "a3", "a2"]);
    expect(ids(sortAgents(items, "status", "desc"))).toEqual(["a2", "a3", "a1", "b1"]);
  });
  it("ties fall back to Herdr order", () => {
    const tied = flattenOverview([ws(1, "w", [tab(1, "t", [agent("z", { paneNumber: 2, harness: "OMP" }), agent("y", { paneNumber: 1, harness: "OMP" })])])]);
    expect(ids(sortAgents(tied, "harness", "asc"))).toEqual(["y", "z"]);
    expect(ids(sortAgents(tied, "harness", "desc"))).toEqual(["y", "z"]);
  });
  it("text fields compare case-insensitively; a missing value is last", () => {
    const named = flattenOverview([ws(1, "w", [tab(1, "t", [agent("n1", { paneNumber: 1, model: "openai/b" }), agent("n2", { paneNumber: 2, model: "Anthropic/a" }), agent("n3", { paneNumber: 3, model: null })])])]);
    expect(ids(sortAgents(named, "model", "asc"))).toEqual(["n2", "n1", "n3"]);
    expect(ids(sortAgents(named, "model", "desc"))).toEqual(["n1", "n2", "n3"]);
  });
  it("cache cold sorts on the absolute estimate; agents without one are last", () => {
    const cache = (anchor: string | null) => ({ provider: "anthropic" as const, anchorAt: anchor, ttlSec: 300, ttlKnown: false });
    const caches = flattenOverview([ws(1, "w", [tab(1, "t", [
      agent("c1", { paneNumber: 1, cache: cache(iso(10)) }), agent("c2", { paneNumber: 2, cache: cache(iso(2)) }),
      agent("c3", { paneNumber: 3, cache: null }), agent("c4", { paneNumber: 4, cache: cache(null) }),
    ])])]);
    // c2 was last used earlier (12:02), so it goes cold sooner than c1 (12:10).
    expect(ids(sortAgents(caches, "cacheCold", "asc"))).toEqual(["c2", "c1", "c3", "c4"]);
    expect(ids(sortAgents(caches, "cacheCold", "desc"))).toEqual(["c1", "c2", "c3", "c4"]);
  });
  it("flag and count fields", () => {
    const flags = flattenOverview([ws(1, "w", [tab(1, "t", [
      agent("f1", { paneNumber: 1, paseoAgentId: null, inputReady: false, duplicateChatIds: [] }),
      agent("f2", { paneNumber: 2, paseoAgentId: "chat", inputReady: true, duplicateChatIds: ["d1", "d2"] }),
      agent("f3", { paneNumber: 3, paseoAgentId: "chat2", inputReady: null }),
    ])])]);
    expect(ids(sortAgents(flags, "hasChat", "desc"))).toEqual(["f2", "f3", "f1"]);
    expect(ids(sortAgents(flags, "inputReady", "desc"))).toEqual(["f2", "f1", "f3"]);
    expect(ids(sortAgents(flags, "duplicates", "desc"))).toEqual(["f2", "f1", "f3"]);
  });
  it("does not mutate its input and sorts every field without throwing", () => {
    const copy = [...items];
    for (const field of ["herdr", "lastActivity", "stateChanged", "cacheCold", "sessionStarted", "status", "title", "harness", "model", "workspace", "tab", "pane", "folder", "hasChat", "inputReady", "duplicates"] as SortField[]) {
      sortAgents(items, field, defaultDir(field));
    }
    expect(items).toEqual(copy);
    expect(comparator("title", "asc")(items[0]!, items[0]!)).toBe(0);
  });
});

describe("grouping", () => {
  it("sorts agents inside each card and orders cards by their first agent", () => {
    const groups = groupAgents(sample, { field: "lastActivity", dir: "desc", grouped: true });
    expect(groups.map((g) => g.workspace.label)).toEqual(["alpha", "beta"]); // alpha's first agent is a3 (newest)
    expect(ids(groups[0]!.agents)).toEqual(["a3", "a1", "a2"]);
    const oldest = groupAgents(sample, { field: "lastActivity", dir: "asc", grouped: true });
    expect(oldest.map((g) => g.workspace.label)).toEqual(["alpha", "beta"]); // a1 (1 min) leads alpha
    const status = groupAgents(sample, { field: "status", dir: "asc", grouped: true });
    expect(status.map((g) => g.workspace.label)).toEqual(["beta", "alpha"]); // blocked b1 leads
  });
  it("ties between cards go to the lower workspace number; empty workspaces come last", () => {
    const a = ws(3, "c", [tab(1, "t", [agent("c1", { harness: "OMP" })])]);
    const b = ws(2, "b", [tab(1, "t", [agent("b1", { harness: "OMP" })])]);
    const empty = ws(1, "empty", []);
    const groups = groupAgents([a, empty, b], { field: "harness", dir: "asc", grouped: true });
    expect(groups.map((g) => g.workspace.label)).toEqual(["b", "c", "empty"]);
  });
  it("flat mode is one list of every agent", () => {
    expect(ids(flatAgents(sample, { field: "herdr", dir: "asc", grouped: false }))).toEqual(["a1", "a2", "a3", "b1"]);
  });
});

describe("older daemon", () => {
  it("an agent row without any of the new fields still parses, with no invented values", () => {
    const old = agent("o");
    expect(old).toMatchObject({ paneNumber: null, lastActivityAt: null, lastActivitySource: null, stateChangedAt: null, stateChangedExact: false, stateChangeSeq: 0, sessionStartedAt: null, lastAssistantAt: null, model: null, cache: null });
  });
});
