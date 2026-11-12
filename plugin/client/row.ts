import type { FlatAgent } from "./sort.js";
import { agentSpeech, placeText, statusLabel } from "./helpers.js";
import { agoText, cacheColdAtMs, classifyCache, cacheText, clockText, isCacheAlert, stateDurationText, type CacheState } from "./time.js";

/**
 * The strings one agent row shows, built from plain values so the row component can be memoised on them: the screen's
 * tick re-renders every row, and only a row whose text actually changed repaints.
 */
export interface RowTexts {
  /** Line 2: where the agent is (and its folder when that adds something). */
  place: string;
  /** The time and cache facts, joined; may be empty. */
  times: string;
  /** The cache fragment alone, so the row can colour it. */
  cache: string | null;
  /** Blocked with a cooling cache: warning tone, on phones too. */
  alert: boolean;
  speech: string;
}

const stripAgo = (text: string | null): string | null => (text ? text.replace(/ ago$/, "") : null);

export function rowTexts(item: FlatAgent, label: string, nowMs: number, opts: { compact: boolean; grouped: boolean }): RowTexts {
  const { agent } = item;
  const state: CacheState = classifyCache(agent.cache, agent.status, nowMs);
  const cache = cacheText(state, opts.compact);
  const stateDur = stateDurationText(agent.stateChangedAt, agent.stateChangedExact, nowMs);
  const active = agoText(agent.lastActivityAt, nowMs);
  const started = agoText(agent.sessionStartedAt, nowMs, false);
  const showCwd = agent.cwd && (!opts.grouped || agent.cwd !== item.workspace.cwd);
  let place: string;
  let times: string[];
  if (opts.compact) {
    const head = `${statusLabel(agent.status)}${stateDur ? ` ${stateDur}` : ""}`;
    const where = [
      opts.grouped ? null : `W${item.workspace.number} ${item.workspace.label}`,
      `T${item.tab.number} ${item.tab.label}`,
      agent.paneNumber !== null ? `P${agent.paneNumber}` : null,
    ];
    place = [head, ...where].filter(Boolean).join(" · ");
    times = [active ? `active ${stripAgo(active)}` : null, cache].filter((part): part is string => Boolean(part));
  } else {
    place = [placeText(item, opts.grouped), showCwd ? agent.cwd : null].filter(Boolean).join(" · ");
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
    times: times.join(" · "),
    cache,
    alert: isCacheAlert(state, agent.status),
    speech: agentSpeech(item, label, state, nowMs),
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
  const cold = coldAt === null ? null : clockText(new Date(coldAt).toISOString(), nowMs);
  if (agent.cache && cold) {
    const lifetime = agent.cache.ttlSec >= 3600 ? "1-hour" : "5-min";
    lines.push({ label: "Cache cold", value: `≈ ${cold} (estimate: Anthropic ${lifetime} cache from the last request${agent.cache.ttlKnown ? "" : "; lifetime assumed"})` });
  }
  if (agent.model) lines.push({ label: "Model", value: agent.model });
  lines.push({ label: "Pane", value: agent.paneId }, { label: "Terminal", value: agent.terminalId });
  return lines;
}
