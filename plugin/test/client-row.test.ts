import { describe, expect, it } from "vitest";
import { overviewAgentSchema } from "../shared/rpc.js";
import { clockText, clockTextMs, cacheColdAtMs, classifyCache, cacheText, stateDurationText, tickIntervalMs } from "../client/time.js";
import { detailLines, rowTexts } from "../client/row.js";
import { dirLabel, sortAgents, type FlatAgent } from "../client/sort.js";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const item = (extra: object = {}, id = "t1"): FlatAgent => ({
  agent: overviewAgentSchema.parse({
    terminalId: id, paneId: "p1", name: null, title: id, kind: "omp", harness: "OMP", provider: "herdr-omp", status: "blocked", cwd: "/a",
    paseoAgentId: null, attachCommand: "x", attach: null, inputReady: null, canRestart: false, paneNumber: 1, ...extra,
  }),
  workspace: { id: "w1", number: 1, label: "proj", cwd: "/a" },
  tab: { id: "tab1", number: 1, label: "one" },
});
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
  it("keeps the pane number out of the part that gets shortened", () => {
    const row = rowTexts(item({ cwd: "/very/long/absolute/path/to/the/project" }), "x", NOW, { compact: false, grouped: false });
    expect(row.pin).toBe("P1");
    expect(row.place).not.toContain("P1");
    expect(row.place).toBe("W1 proj › T1 one · …/the/project");
    expect(rowTexts(item({ paneNumber: null }), "x", NOW, { compact: true, grouped: true }).pin).toBe("");
  });
  it("a tab named by its number is not repeated", () => {
    const numbered = { ...item(), tab: { id: "t", number: 1, label: "1" } };
    expect(rowTexts(numbered, "x", NOW, { compact: false, grouped: true }).place).toBe("T1");
    expect(rowTexts(numbered, "x", NOW, { compact: true, grouped: true }).place).toContain("Blocked");
    expect(rowTexts(numbered, "x", NOW, { compact: true, grouped: true }).speech).toContain("tab 1,");
  });
});

describe("wording", () => {
  it("a state first seen just now reads as a lower bound, like later ones", () => {
    expect(stateDurationText(new Date(NOW - 10_000).toISOString(), false, NOW)).toBe("≥ 0m");
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
