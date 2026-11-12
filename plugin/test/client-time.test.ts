import { describe, expect, it } from "vitest";
import { agoText, cacheText, classifyCache, clockSkewMs, clockText, formatSpan, isCacheAlert, stateDurationText, tickIntervalMs } from "../client/time.js";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
const cache = (anchorAgoSec: number | null, ttlSec = 300) => ({ provider: "anthropic" as const, anchorAt: anchorAgoSec === null ? null : iso(anchorAgoSec), ttlSec, ttlKnown: false });

describe("formatSpan / agoText", () => {
  it("formats compact spans", () => {
    expect(formatSpan(40)).toBe("40s");
    expect(formatSpan(59.9)).toBe("59s");
    expect(formatSpan(180)).toBe("3m");
    expect(formatSpan(7200)).toBe("2h");
    expect(formatSpan(7500)).toBe("2h 5m");
    expect(formatSpan(3 * 86400 + 5)).toBe("3d");
  });
  it("never shows seconds when asked not to", () => {
    expect(formatSpan(40, false)).toBe("<1m");
    expect(agoText(iso(40), NOW, false)).toBe("<1m");
    expect(agoText(iso(40), NOW)).toBe("40s ago");
    expect(agoText(iso(3600), NOW, false)).toBe("1h ago");
  });
  it("never invents a time", () => {
    expect(agoText(null, NOW)).toBeNull();
    expect(agoText("not a date", NOW)).toBeNull();
    expect(stateDurationText(null, true, NOW)).toBeNull();
  });
  it("a time slightly ahead of the clock reads as zero elapsed", () => {
    expect(agoText(iso(-5), NOW)).toBe("0s ago");
  });
});

describe("stateDurationText", () => {
  it("exact: plain minutes, no seconds", () => {
    expect(stateDurationText(iso(180), true, NOW)).toBe("3m");
    expect(stateDurationText(iso(20), true, NOW)).toBe("<1m");
  });
  it("inexact: a lower bound", () => {
    expect(stateDurationText(iso(52 * 60), false, NOW)).toBe("≥ 52m");
    expect(stateDurationText(iso(10), false, NOW)).toBe("just now (watching)");
  });
});

describe("clockText", () => {
  it("shows the local time, with the date when it is not today", () => {
    expect(clockText("2026-11-12T13:10:00Z", NOW, "UTC")).toBe("13:10");
    expect(clockText("2026-11-11T13:10:00Z", NOW, "UTC")).toBe("11 Nov 13:10");
    expect(clockText(null, NOW)).toBeNull();
  });
});

describe("clockSkewMs", () => {
  it("is the daemon clock minus the device clock at receipt; 0 when unknown", () => {
    expect(clockSkewMs("2026-11-12T12:00:05Z", NOW)).toBe(5000);
    expect(clockSkewMs(undefined, NOW)).toBe(0);
    expect(clockSkewMs("junk", NOW)).toBe(0);
  });
});

describe("classifyCache", () => {
  it("is hidden for a model with no estimate (non-Anthropic or unknown)", () => {
    expect(classifyCache(null, "idle", NOW)).toEqual({ kind: "hidden" });
    expect(cacheText({ kind: "hidden" }, false)).toBeNull();
  });
  it("working is in use, whatever the clock says", () => {
    expect(classifyCache(cache(1000), "working", NOW)).toEqual({ kind: "in-use" });
  });
  it("warm with more than a minute left on the 5-minute lifetime", () => {
    expect(classifyCache(cache(120), "idle", NOW)).toEqual({ kind: "warm", secondsLeft: 180 });
  });
  it("cooling at or under a minute left", () => {
    expect(classifyCache(cache(240), "idle", NOW)).toEqual({ kind: "cooling", secondsLeft: 60 });
    expect(classifyCache(cache(255), "idle", NOW)).toEqual({ kind: "cooling", secondsLeft: 45 });
  });
  it("cold at zero and after", () => {
    expect(classifyCache(cache(300), "idle", NOW).kind).toBe("cold");
    expect(classifyCache(cache(720), "done", NOW)).toEqual({ kind: "cold", secondsLeft: -420 });
  });
  it("the 1-hour lifetime cools at ten minutes", () => {
    expect(classifyCache(cache(3000, 3600), "idle", NOW)).toEqual({ kind: "cooling", secondsLeft: 600 });
    expect(classifyCache(cache(2900, 3600), "idle", NOW)).toEqual({ kind: "warm", secondsLeft: 700 });
  });
  it("Anthropic with no message time is unknown", () => {
    expect(classifyCache(cache(null), "idle", NOW)).toEqual({ kind: "unknown" });
    expect(cacheText({ kind: "unknown" }, false)).toBe("cache: unknown");
    expect(cacheText({ kind: "unknown" }, true)).toBeNull();
  });
});

describe("cacheText", () => {
  it("every visible estimate says est.", () => {
    expect(cacheText({ kind: "warm", secondsLeft: 180 }, false)).toBe("cache cold in 3m (est.)");
    expect(cacheText({ kind: "cooling", secondsLeft: 45 }, false)).toBe("cache cold in 45s ⚠ (est.)");
    expect(cacheText({ kind: "cold", secondsLeft: -420 }, false)).toBe("cache cold 7m ago (est.)");
    expect(cacheText({ kind: "in-use" }, false)).toBe("cache in use");
    expect(cacheText({ kind: "cooling", secondsLeft: 45 }, true)).toBe("cache 45s⚠ est.");
    expect(cacheText({ kind: "warm", secondsLeft: 180 }, true)).toContain("est.");
    expect(cacheText({ kind: "cold", secondsLeft: -5 }, true)).toContain("est.");
  });
});

describe("isCacheAlert", () => {
  it("only blocked plus cooling", () => {
    expect(isCacheAlert({ kind: "cooling", secondsLeft: 30 }, "blocked")).toBe(true);
    expect(isCacheAlert({ kind: "cooling", secondsLeft: 30 }, "idle")).toBe(false);
    expect(isCacheAlert({ kind: "warm", secondsLeft: 200 }, "blocked")).toBe(false);
  });
});

describe("tickIntervalMs", () => {
  it("1 s while any countdown is under two minutes, else 15 s", () => {
    expect(tickIntervalMs([{ kind: "warm", secondsLeft: 110 }])).toBe(1000);
    expect(tickIntervalMs([{ kind: "cooling", secondsLeft: 20 }])).toBe(1000);
    expect(tickIntervalMs([{ kind: "warm", secondsLeft: 200 }, { kind: "cold", secondsLeft: -10 }, { kind: "in-use" }])).toBe(15000);
    expect(tickIntervalMs([])).toBe(15000);
  });
});
