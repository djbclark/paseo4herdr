import { describe, expect, it } from "vitest";
import { overviewAgentSchema } from "../shared/rpc.js";
import { clockText, clockTextMs, cacheColdAtMs, classifyCache, cacheText, stateDurationText, tickIntervalMs } from "../client/time.js";
import { detailLines, rowTexts } from "../client/row.js";
import { dirLabel, sortAgents, type FlatAgent } from "../client/sort.js";
import { agentLabel } from "../client/helpers.js";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const item = (extra: object = {}, id = "t1"): FlatAgent => ({
  agent: overviewAgentSchema.parse({
    terminalId: id, paneId: "p1", name: null, title: id, kind: "omp", harness: "OMP", provider: "herdr-omp", status: "blocked", cwd: "/a",
    paseoAgentId: null, attachCommand: "x", attach: null, inputReady: null, canRestart: false, paneNumber: 1, ...extra,
  }),
  workspace: { id: "w1", number: 1, label: "proj", cwd: "/a" },
  tab: { id: "tab1", number: 1, label: "one" },
  tabPanes: 1,
});
const plain = (extra: object = {}, id = "sh1"): FlatAgent => item({ kind: null, harness: null, provider: null, status: "unknown", title: null, plain: true, isShell: true, program: "zsh", ...extra }, id);
const cache = (anchorAgoSec: number) => ({ provider: "anthropic" as const, anchorAt: new Date(NOW - anchorAgoSec * 1000).toISOString(), ttlSec: 300, ttlKnown: false });

describe("accessibility label", () => {
  it("does not change with the second-by-second countdown, only when the minute moves", () => {
    const a = item({ cache: cache(250) }); // 50 s left
    const opts = { compact: false, grouped: true };
    const one = rowTexts(a, "Fix tests", NOW, opts);
    const two = rowTexts(a, "Fix tests", NOW + 7000, opts);
    expect(two.speech).toBe(one.speech);
    expect(two.times).not.toBe(one.times); // the visible countdown does tick
    expect(one.speech).toContain("less than a minute");
  });
});

describe("hostile times in the details sheet", () => {
  it("an out-of-range date never throws", () => {
    expect(() => clockText("+275760-09-13T00:00:00.000Z", NOW)).not.toThrow();
    expect(clockTextMs(8.64e15 + 300000, NOW)).toBeNull();
    expect(clockTextMs(Number.NaN, NOW)).toBeNull();
    const hostile = item({ cache: { provider: "anthropic", anchorAt: "+275760-09-13T00:00:00.000Z", ttlSec: 300, ttlKnown: false }, lastActivityAt: "+275760-09-13T00:00:00.000Z" });
    expect(cacheColdAtMs(hostile.agent.cache)).toBeNull();
    expect(() => detailLines(hostile, NOW)).not.toThrow();
  });
});

describe("sort details", () => {
  it("cache cold ranks a working agent last, not first on its stale estimate", () => {
    const working = item({ status: "working", cache: cache(900) }, "w");
    const blocked = item({ status: "blocked", cache: cache(260) }, "b");
    expect(sortAgents([working, blocked], "cacheCold", "asc").map((x) => x.agent.terminalId)).toEqual(["b", "w"]);
  });
  it("Title sorts on the label the row shows, including the terminal-id fallback", () => {
    const bare = item({ title: null, name: null, kind: null }, "aaa");
    const named = item({ title: "zzz" }, "t2");
    // "aaa" is what the row shows for the bare agent, so it sorts first alphabetically.
    expect(sortAgents([named, bare], "title", "asc").map((x) => x.agent.terminalId)).toEqual(["aaa", "t2"]);
  });
});

describe("place line", () => {
  it("uses the names a Herdr user knows, with no W/T/P codes, and shows a pane only when it is needed", () => {
    const lone = rowTexts(item({ cwd: "/very/long/absolute/path/to/the/project" }), "x", NOW, { compact: false, grouped: false });
    expect(lone.place).toBe("proj › one · …/the/project");
    expect(lone.pin).toBe(""); // the only pane in its tab: nothing to tell apart
    const shared = { ...item(), tabPanes: 2 };
    const row = rowTexts(shared, "x", NOW, { compact: false, grouped: false });
    expect(row.pin).toBe("pane 1");
    expect(row.place).not.toContain("pane");
    expect(rowTexts({ ...shared, agent: { ...shared.agent, paneNumber: null } }, "x", NOW, { compact: true, grouped: true }).pin).toBe("");
    for (const text of [row.place, row.pin, row.speech, lone.place]) expect(text).not.toMatch(/\b[WTP]\d/);
  });
  it("a pane the Herdr user named shows that name, even alone in its tab", () => {
    expect(rowTexts(item({ paneLabel: "logs" }), "x", NOW, { compact: false, grouped: true }).pin).toBe("logs");
    expect(rowTexts(item({ paneLabel: "logs" }), "x", NOW, { compact: false, grouped: true }).speech).toContain("pane logs");
  });
  it("a tab named by its number is not repeated", () => {
    const numbered = { ...item(), tab: { id: "t", number: 1, label: "1" } };
    expect(rowTexts(numbered, "x", NOW, { compact: false, grouped: true }).place).toBe("tab 1");
    expect(rowTexts(numbered, "x", NOW, { compact: true, grouped: true }).place).toContain("Blocked");
    expect(rowTexts(numbered, "x", NOW, { compact: true, grouped: true }).speech).toMatch(/tab 1$/);
  });
});

describe("panes with no agent", () => {
  it("say what they run, never an agent status, and carry no time facts", () => {
    const shell = plain();
    const wide = rowTexts(shell, "zsh", NOW, { compact: false, grouped: true });
    expect(wide.times).toBe("");
    expect(wide.speech).toContain("zsh, shell");
    expect(wide.speech).not.toMatch(/blocked|working|idle|unknown/);
    expect(rowTexts(shell, "zsh", NOW, { compact: true, grouped: true }).place).toBe("Shell · one");
    const program = plain({ isShell: false, program: "vim" });
    expect(rowTexts(program, "vim", NOW, { compact: true, grouped: true }).place).toBe("vim · one");
    expect(rowTexts(plain({ isShell: false, program: null }), "x", NOW, { compact: true, grouped: true }).place).toBe("Terminal · one");
  });
  it("the inline details name the program and never invents agent facts", () => {
    const lines = detailLines(plain(), NOW);
    expect(lines).toContainEqual({ label: "Running", value: "zsh (shell)" });
    expect(lines.map((line) => line.label)).toEqual(["Running", "Folder", "Pane", "Terminal"]);
  });
  it("sort: they rank after every agent state and have no cache or time to sort on", () => {
    const shell = plain();
    const idle = item({ status: "idle" }, "idle");
    expect(sortAgents([shell, idle], "status", "asc").map((x) => x.agent.terminalId)).toEqual(["idle", "sh1"]);
    expect(sortAgents([idle, shell], "cacheCold", "asc")[1]!.agent.terminalId).toBe("sh1");
  });
  it("the title sort and label fall back to the program name", () => {
    expect(agentLabel({ title: null, name: null, kind: null, terminalId: "t-1", program: "zsh" })).toBe("zsh");
  });
});

describe("wording", () => {
  it("a state first seen just now reads as a lower bound, like later ones", () => {
    expect(stateDurationText(new Date(NOW - 10_000).toISOString(), false, NOW)).toBe("<1m");
    expect(stateDurationText(new Date(NOW - 52 * 60_000).toISOString(), false, NOW)).toBe("≥ 52m");
  });
  it("a cache that went cold a moment ago does not say 0s ago", () => {
    const state = classifyCache(cache(301), "idle", NOW);
    expect(cacheText(state, false)).toBe("cache cold just now (est.)");
  });
  it("the accessibility label carries how long the agent has been in its state", () => {
    const exact = item({ stateChangedAt: new Date(NOW - 3 * 60_000).toISOString(), stateChangedExact: true });
    expect(rowTexts(exact, "x", NOW, { compact: false, grouped: true }).speech).toContain("blocked for 3 minutes");
    const bound = item({ stateChangedAt: new Date(NOW - 3 * 60_000).toISOString(), stateChangedExact: false });
    expect(rowTexts(bound, "x", NOW, { compact: false, grouped: true }).speech).toContain("blocked for at least 3 minutes");
  });
});

describe("tick interval", () => {
  it("goes fast as soon as a countdown is in its last two minutes and back to slow when none is", () => {
    const warm = classifyCache(cache(200), "idle", NOW); // 100 s left
    const far = classifyCache(cache(10), "idle", NOW);
    expect(tickIntervalMs([far])).toBe(15000);
    expect(tickIntervalMs([far, warm])).toBe(1000);
    expect(tickIntervalMs([])).toBe(15000);
  });
  it("the default sort direction chip does not repeat the field name", () => {
    expect(dirLabel("herdr", "asc")).toBe("Pane order");
  });
});
