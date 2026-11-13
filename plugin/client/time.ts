import type { HerdrAgentStatus, OverviewAgent } from "../shared/rpc.js";

/**
 * Pure time formatting and prompt-cache classification for the Herdr screen (no React, no clock reads: every function takes
 * `nowMs`). A missing time is null and shows as nothing; nothing here invents one.
 */

const parse = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};

/** Milliseconds to add to this device's clock to get the daemon's: `serverNow` minus the device clock at receipt. Null when unknown. */
export function clockSkewMs(serverNow: string | undefined, receivedAtMs: number): number {
  const server = parse(serverNow);
  return server === null ? 0 : server - receivedAtMs;
}

/** Compact span: `40s`, `3m`, `2h 5m`, `3d`. Seconds only below a minute, and only when `seconds` is set (else `<1m`). */
export function formatSpan(totalSeconds: number, seconds = true): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return seconds ? `${s}s` : "<1m";
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

/** `40s ago` style text for a time in the past; null when there is no time. A time slightly ahead of the clock reads as zero elapsed. */
export function agoText(iso: string | null, nowMs: number, seconds = true): string | null {
  const at = parse(iso);
  if (at === null) return null;
  const span = formatSpan((nowMs - at) / 1000, seconds);
  return span === "<1m" ? span : `${span} ago`;
}

/**
 * How long an agent has been in its state. Never shows seconds (the plugin samples Herdr, so the time is only good to the
 * poll interval). A time that is only a lower bound (the plugin started watching then) reads `≥ 52m`.
 */
export function stateDurationText(iso: string | null, exact: boolean, nowMs: number): string | null {
  const at = parse(iso);
  if (at === null) return null;
  const span = formatSpan((nowMs - at) / 1000, false);
  if (exact) return span;
  return `≥ ${span === "<1m" ? "0m" : span}`;
}

/** Sentence form of the state duration for screen readers: `for 3 minutes`, `for at least 3 minutes`; null under a minute and unknown. */
export function stateDurationSpeech(iso: string | null, exact: boolean, nowMs: number): string | null {
  const at = parse(iso);
  if (at === null) return null;
  const seconds = (nowMs - at) / 1000;
  if (seconds < 60) return exact ? "for less than a minute" : null;
  return `for ${exact ? "" : "at least "}${spoken(seconds)}`;
}

/** Local clock text for the details sheet: `13:10`, with the short date when it isn't today. `timeZone` is for tests. */
export function clockText(iso: string | null, nowMs: number, timeZone?: string): string | null {
  const at = parse(iso);
  return at === null ? null : clockTextMs(at, nowMs, timeZone);
}

/** As {@link clockText} for a millisecond time; null for a time outside the range a date can hold (never throws). */
export function clockTextMs(at: number, nowMs: number, timeZone?: string): string | null {
  if (!Number.isFinite(at) || Math.abs(at) > 8.64e15) return null;
  try {
    return formatClock(at, nowMs, timeZone);
  } catch {
    return null;
  }
}

function formatClock(at: number, nowMs: number, timeZone?: string): string {
  const options = timeZone ? { timeZone } : {};
  const time = new Intl.DateTimeFormat("en-GB", { ...options, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  const day = (ms: number) => new Intl.DateTimeFormat("en-GB", { ...options, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  if (day(at) === day(nowMs)) return time;
  const date = new Intl.DateTimeFormat("en-GB", { ...options, day: "numeric", month: "short" }).format(at);
  return `${date} ${time}`;
}

export type CacheState =
  | { kind: "hidden" }
  | { kind: "unknown" }
  | { kind: "in-use" }
  | { kind: "warm" | "cooling" | "cold"; secondsLeft: number };

type CacheFacts = NonNullable<OverviewAgent["cache"]>;

/** When the cache is estimated to go cold, in ms; null when there is no estimate. */
export function cacheColdAtMs(cache: OverviewAgent["cache"]): number | null {
  const anchor = parse(cache?.anchorAt);
  const coldAt = cache && anchor !== null ? anchor + cache.ttlSec * 1000 : null;
  return coldAt !== null && Math.abs(coldAt) <= 8.64e15 ? coldAt : null;
}

/** Seconds left before the "cooling" warning: a minute on the 5-minute lifetime, ten on the 1-hour one. */
export const coolingThresholdSec = (cache: CacheFacts): number => (cache.ttlSec >= 3600 ? 600 : 60);

/**
 * Where an Anthropic prompt cache stands. Null cache (any other or unknown model) is hidden: the row shows nothing.
 * A working agent is using its cache.
 */
export function classifyCache(cache: OverviewAgent["cache"], status: HerdrAgentStatus, nowMs: number): CacheState {
  if (!cache) return { kind: "hidden" };
  if (status === "working") return { kind: "in-use" };
  const coldAt = cacheColdAtMs(cache);
  if (coldAt === null) return { kind: "unknown" };
  const secondsLeft = Math.ceil((coldAt - nowMs) / 1000);
  if (secondsLeft <= 0) return { kind: "cold", secondsLeft };
  return { kind: secondsLeft <= coolingThresholdSec(cache) ? "cooling" : "warm", secondsLeft };
}

/** Every visible form says "est.". `compact` is the phone form; it returns null for what a phone hides. */
export function cacheText(state: CacheState, compact: boolean): string | null {
  switch (state.kind) {
    case "hidden":
      return null;
    case "unknown":
      return compact ? null : "cache: unknown";
    case "in-use":
      return "cache in use";
    case "warm":
      return compact ? `cache ${formatSpan(state.secondsLeft)} est.` : `cache cold in ${formatSpan(state.secondsLeft)} (est.)`;
    case "cooling":
      return compact ? `cache ${formatSpan(state.secondsLeft)}⚠ est.` : `cache cold in ${formatSpan(state.secondsLeft)} ⚠ (est.)`;
    case "cold":
      return compact ? "cache cold est." : -state.secondsLeft < 60 ? "cache cold just now (est.)" : `cache cold ${formatSpan(-state.secondsLeft)} ago (est.)`;
  }
}

/** Sentence form for the accessibility label. */
export function cacheSpeech(state: CacheState): string | null {
  switch (state.kind) {
    case "hidden":
    case "unknown":
      return null;
    case "in-use":
      return "cache in use";
    case "warm":
    case "cooling":
      return state.secondsLeft < 60 ? "cache estimated cold in less than a minute" : `cache estimated cold in ${spoken(state.secondsLeft)}`;
    case "cold":
      return -state.secondsLeft < 60 ? "cache estimated cold less than a minute ago" : `cache estimated cold ${spoken(-state.secondsLeft)} ago`;
  }
}

/** `3 minutes`, `1 hour 5 minutes`: for screen readers, which read `3m` badly. */
export function spoken(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? "" : "s"}`;
  if (s < 60) return unit(s, "second");
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? unit(hours, "hour") : `${unit(hours, "hour")} ${unit(minutes % 60, "minute")}`;
  return unit(Math.floor(hours / 24), "day");
}

/** A blocked agent whose cache is about to go cold: the one case that gets a warning tone on phones too. */
export function isCacheAlert(state: CacheState, status: HerdrAgentStatus): boolean {
  return status === "blocked" && state.kind === "cooling";
}

export const TICK_FAST_MS = 1000;
export const TICK_SLOW_MS = 15000;
const COUNTDOWN_WINDOW_SEC = 120;

/**
 * How often the one screen-level clock should tick: every second while any visible countdown is under two minutes, else
 * every 15 seconds. Takes the states as of the last tick.
 */
export function tickIntervalMs(states: readonly CacheState[]): number {
  const counting = states.some((state) => (state.kind === "warm" || state.kind === "cooling") && state.secondsLeft < COUNTDOWN_WINDOW_SEC);
  return counting ? TICK_FAST_MS : TICK_SLOW_MS;
}
