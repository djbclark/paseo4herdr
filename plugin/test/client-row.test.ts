import { describe, expect, it } from "vitest";
import { overviewAgentSchema } from "../shared/rpc.js";
import { clockText, clockTextMs, cacheColdAtMs } from "../client/time.js";
import { detailLines, rowTexts } from "../client/row.js";
import { sortAgents, type FlatAgent } from "../client/sort.js";

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
