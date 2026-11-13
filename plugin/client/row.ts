import type { FlatAgent } from "./sort.js";
import { agentSpeech, shortPath, statusLabel, tabText } from "./helpers.js";
import { agoText, cacheColdAtMs, classifyCache, cacheText, clockText, clockTextMs, isCacheAlert, stateDurationText, type CacheState } from "./time.js";

/**
 * The strings one agent row shows, built from plain values so the row component can be memoised on them: the screen's
 * tick re-renders every row, and only a row whose text actually changed repaints.
 */
export interface RowTexts {
  /** Line 2: where the agent is (and its folder when that adds something). */
  place: string;
  /** The pane number (`P1`), shown after the place and never cut; empty when Herdr gave none. */
  pin: string;
  /** The time and cache facts, joined; may be empty. */
  times: string;
  /** The cache fragment alone, so the row can colour it. */
  cache: string | null;
  /** Blocked with a cooling cache: warning tone, on phones too. */
  alert: boolean;
  speech: string;
}

/** Workspace and tab of the place line, without the pane (see `pin`). */
const grouped = (item: FlatAgent, isGrouped: boolean): string => (isGrouped ? [] : [`W${item.workspace.number} ${item.workspace.label}`.trim()]).concat(tabText(item.tab)).join(" › ");

const stripAgo = (text: string | null): string | null => (text ? text.replace(/ ago$/, "") : null);

export function rowTexts(item: FlatAgent, label: string, nowMs: number, opts: { compact: boolean; grouped: boolean }): RowTexts {
  const { agent } = item;
  const state: CacheState = classifyCache(agent.cache, agent.status, nowMs);
  const speechNow = Math.floor(nowMs / 60_000) * 60_000;
  const cache = cacheText(state, opts.compact);
  const stateDur = stateDurationText(agent.stateChangedAt, agent.stateChangedExact, nowMs);
  const active = agoText(agent.lastActivityAt, nowMs);
  const started = agoText(agent.sessionStartedAt, nowMs, false);
  const showCwd = agent.cwd && (!opts.grouped || agent.cwd !== item.workspace.cwd);
  const pane = agent.paneNumber !== null ? `P${agent.paneNumber}` : null;
  let place: string;
  let times: string[];
  if (opts.compact) {
    const head = `${statusLabel(agent.status)}${stateDur ? ` ${stateDur}` : ""}`;
    place = [head, opts.grouped ? null : `W${item.workspace.number} ${item.workspace.label}`, tabText(item.tab)].filter(Boolean).join(" · ");
    times = [active ? `active ${stripAgo(active)}` : null, cache].filter((part): part is string => Boolean(part));
  } else {
    // The pane number is returned apart from the place, so a narrow row can shorten the place and still show it.
    place = [grouped(item, opts.grouped), showCwd ? shortPath(agent.cwd as string) : null].filter(Boolean).join(" · ");
    times = [
      active ? `active ${active}` : null,
      stateDur ? `${agent.status} ${stateDur}` : null,
      cache,
      started ? `started ${started}` : null,
      agent.model,
    ].filter((part): part is string => Boolean(part));
  }
  return {
    place,
    pin: pane ?? "",
    times: times.join(" · "),
    cache,
    alert: isCacheAlert(state, agent.status),
    // The screen-reader sentence changes once a minute, not with the second-by-second countdown.
    speech: agentSpeech(item, label, classifyCache(agent.cache, agent.status, speechNow), speechNow),
  };
}

export interface DetailLine { label: string; value: string }

const ACTIVITY_SOURCE = { transcript: "last message in the transcript", "session-file": "session file modified", chat: "Paseo chat updated" } as const;

/** The ⋯ sheet's Details block: each fact with its absolute local time and where it came from. Facts we don't have are left out. */
export function detailLines(item: FlatAgent, nowMs: number): DetailLine[] {
  const { agent } = item;
  const lines: DetailLine[] = [];
  const last = clockText(agent.lastActivityAt, nowMs);
  if (last) lines.push({ label: "Last activity", value: `${last} (${agent.lastActivitySource ? ACTIVITY_SOURCE[agent.lastActivitySource] : "unknown source"})` });
  const changed = clockText(agent.stateChangedAt, nowMs);
  if (changed) lines.push({ label: "State changed", value: agent.stateChangedExact ? `${changed} (seen by the plugin; good to about the poll interval)` : `≥ ${changed} (watching since)` });
  const started = clockText(agent.sessionStartedAt, nowMs);
  if (started) lines.push({ label: "Session started", value: `${started} (session file header)` });
  const coldAt = cacheColdAtMs(agent.cache);
  const cold = coldAt === null ? null : clockTextMs(coldAt, nowMs);
  if (agent.cache && cold) {
    const lifetime = agent.cache.ttlSec >= 3600 ? "1-hour" : "5-min";
    lines.push({ label: "Cache cold", value: `≈ ${cold} (estimate: Anthropic ${lifetime} cache from the last request${agent.cache.ttlKnown ? "" : "; lifetime assumed"})` });
  }
  if (agent.model) lines.push({ label: "Model", value: agent.model });
  lines.push({ label: "Pane", value: agent.paneId }, { label: "Terminal", value: agent.terminalId });
  return lines;
}
