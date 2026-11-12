import { open, stat } from "node:fs/promises";
import type { AgentStatus } from "./herdr/schema.js";

/**
 * Facts the overview shows per agent beyond what Herdr reports: a cached summary of the session file, the newest-activity
 * pick, the prompt-cache estimate, and "when did the state change" stamps taken by a poll loop. Nothing here invents a
 * time: a fact it can't find is null.
 */

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};

/** The later of two ISO times; either may be missing. Unparseable text counts as missing. */
export function laterIso(a: string | null | undefined, b: string | null | undefined): string | null {
  const x = ms(a);
  const y = ms(b);
  if (x === null) return y === null ? null : (b ?? null);
  if (y === null) return a ?? null;
  return y > x ? (b ?? null) : (a ?? null);
}

export interface TranscriptSummary {
  /** The session header's timestamp. */
  sessionStartedAt: string | null;
  lastAssistantAt: string | null;
  /** Newest user or tool-result message. */
  lastUserAt: string | null;
  /** `provider/id`: the newest of a model_change entry and an assistant message's provider and model. */
  model: string | null;
}

export const EMPTY_SUMMARY: TranscriptSummary = { sessionStartedAt: null, lastAssistantAt: null, lastUserAt: null, model: null };

/** The last API request: the newest of the last assistant message and the last user or tool-result message. */
export function lastRequestAt(summary: TranscriptSummary): string | null {
  return laterIso(summary.lastAssistantAt, summary.lastUserAt);
}

/**
 * Fold JSONL lines into a summary. Pure; a line that isn't JSON (a half-written one) is skipped. Message times come from
 * the entry's own `timestamp`, never from the file's mtime, which also moves on title and model_change writes.
 */
export function foldTranscriptLines(previous: TranscriptSummary, lines: Iterable<string>): TranscriptSummary {
  const next = { ...previous };
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof entry.timestamp === "string" && ms(entry.timestamp) !== null ? entry.timestamp : null;
    if (entry.type === "session") {
      if (at && !next.sessionStartedAt) next.sessionStartedAt = at;
    } else if (entry.type === "model_change") {
      if (typeof entry.model === "string" && entry.model) next.model = entry.model;
    } else if (entry.type === "message") {
      const message = typeof entry.message === "object" && entry.message !== null ? (entry.message as Record<string, unknown>) : {};
      if (message.role === "assistant") {
        next.lastAssistantAt = laterIso(next.lastAssistantAt, at);
        if (typeof message.provider === "string" && typeof message.model === "string" && message.provider && message.model) {
          next.model = `${message.provider}/${message.model}`;
        }
      } else if (message.role === "user" || message.role === "toolResult") {
        next.lastUserAt = laterIso(next.lastUserAt, at);
      }
    }
  }
  return next;
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  /** Bytes already folded in: everything up to and including the last newline read. */
  offset: number;
  summary: TranscriptSummary;
}

export interface TranscriptRead {
  summary: TranscriptSummary;
  /** The session file's modification time, ISO. */
  mtime: string;
}

/** Past this size the first read takes the file's head (header and first model) and its tail, not the whole file. */
const FULL_READ_LIMIT = 4 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 1024 * 1024;

async function readRange(path: string, start: number, end: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** The complete lines of `text` and how many UTF-8 bytes they (with their newlines) cover; a trailing partial line is left out. */
function completeLines(text: string): { lines: string[]; bytes: number } {
  const cut = text.lastIndexOf("\n");
  if (cut < 0) return { lines: [], bytes: 0 };
  const whole = text.slice(0, cut);
  return { lines: whole.split("\n"), bytes: Buffer.byteLength(whole, "utf8") + 1 };
}

/**
 * Per-session-file summaries, cached by path plus mtime and size so a 4-second overview poll doesn't re-parse transcripts.
 * A file that only grew is read from where the last read stopped; a file that shrank is read again from the start.
 */
export class TranscriptSummaryCache {
  private readonly entries = new Map<string, CacheEntry>();
  /** Counts file reads, for tests. */
  reads = 0;

  constructor(private readonly maxEntries = 256) {}

  async read(path: string): Promise<TranscriptRead | null> {
    let info;
    try {
      info = await stat(path);
    } catch {
      this.entries.delete(path);
      return null;
    }
    if (!info.isFile()) return null;
    const cached = this.entries.get(path);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return { summary: cached.summary, mtime: new Date(info.mtimeMs).toISOString() };
    try {
      // Same size, new mtime: the harness rewrote a header line in place (title, padding); no message was added.
      const entry = cached && info.size === cached.size ? { ...cached }
        : cached && info.size > cached.size ? await this.extend(path, cached, info.size)
        : await this.initial(path, info.size);
      entry.size = info.size;
      entry.mtimeMs = info.mtimeMs;
      this.entries.delete(path);
      this.entries.set(path, entry);
      while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
      return { summary: entry.summary, mtime: new Date(info.mtimeMs).toISOString() };
    } catch {
      return null;
    }
  }

  private async extend(path: string, cached: CacheEntry, size: number): Promise<CacheEntry> {
    this.reads++;
    const { lines, bytes } = completeLines(await readRange(path, cached.offset, size));
    return { ...cached, offset: cached.offset + bytes, summary: foldTranscriptLines(cached.summary, lines) };
  }

  private async initial(path: string, size: number): Promise<CacheEntry> {
    this.reads++;
    if (size <= FULL_READ_LIMIT) {
      const { lines, bytes } = completeLines(await readRange(path, 0, size));
      return { size, mtimeMs: 0, offset: bytes, summary: foldTranscriptLines(EMPTY_SUMMARY, lines) };
    }
    const head = completeLines(await readRange(path, 0, HEAD_BYTES));
    const tailStart = size - TAIL_BYTES;
    const tailText = await readRange(path, tailStart, size);
    // The tail starts mid-line: drop everything up to its first newline.
    const afterFirst = tailText.slice(tailText.indexOf("\n") + 1);
    const tail = completeLines(afterFirst);
    const summary = foldTranscriptLines(foldTranscriptLines(EMPTY_SUMMARY, head.lines), tail.lines);
    return { size, mtimeMs: 0, offset: size - (Buffer.byteLength(afterFirst, "utf8") - tail.bytes), summary };
  }
}

export type ActivitySource = "transcript" | "session-file" | "chat";

/** The newest of the evidence we have, with which kind it was. Nothing known = null. */
export function pickLastActivity(evidence: { transcriptAt: string | null; fileMtime: string | null; chatAt: string | null }): { at: string; source: ActivitySource } | null {
  const candidates: { at: string | null; source: ActivitySource }[] = [
    { at: evidence.transcriptAt, source: "transcript" },
    { at: evidence.fileMtime, source: "session-file" },
    { at: evidence.chatAt, source: "chat" },
  ];
  let best: { at: string; source: ActivitySource } | null = null;
  for (const candidate of candidates) {
    const value = ms(candidate.at);
    if (candidate.at === null || value === null) continue;
    if (best === null || value > (ms(best.at) ?? 0)) best = { at: candidate.at, source: candidate.source };
  }
  return best;
}

/** Anthropic's default prompt-cache lifetime. A 1-hour lifetime is claimed only with proof (`ttlKnown`). */
export const ANTHROPIC_CACHE_TTL_SEC = 300;
export const ANTHROPIC_CACHE_LONG_TTL_SEC = 3600;

export interface CacheInfo {
  provider: "anthropic";
  anchorAt: string | null;
  ttlSec: number;
  ttlKnown: boolean;
}

/**
 * The prompt-cache estimate for a model, or null. Only the `anthropic/` provider prefix counts: a model id that merely
 * contains "claude" can sit behind a proxy with other caching, so it gets no estimate.
 */
export function cacheInfo(model: string | null, summary: TranscriptSummary, oneHourProven = false): CacheInfo | null {
  if (!model || !model.startsWith("anthropic/")) return null;
  return {
    provider: "anthropic",
    anchorAt: lastRequestAt(summary),
    ttlSec: oneHourProven ? ANTHROPIC_CACHE_LONG_TTL_SEC : ANTHROPIC_CACHE_TTL_SEC,
    ttlKnown: oneHourProven,
  };
}

export interface StateStamp {
  /** ISO time the change was seen (or, when inexact, the time we started watching). */
  at: string;
  /** False: first sight of this agent, so the change happened at or before `at`. */
  exact: boolean;
  status: AgentStatus;
  seq: number;
}

/**
 * Remembers when each agent's status or `state_change_seq` last changed, as seen by a server-side poll loop (the overview
 * RPC only runs while a client is watching, so it can't be the one that stamps). Stamps live in memory and are lost on a
 * restart: the first sight of an agent is stamped `exact: false`. A drop in the sequence counts as a change, because Herdr
 * resets it when it restarts. Accurate only to the poll interval.
 */
export class StateStamper {
  private readonly stamps = new Map<string, StateStamp>();

  observe(key: string, status: AgentStatus, seq: number, nowMs: number): StateStamp {
    const known = this.stamps.get(key);
    if (known && known.status === status && known.seq === seq) return known;
    const stamp: StateStamp = { at: new Date(nowMs).toISOString(), exact: known !== undefined, status, seq };
    this.stamps.set(key, stamp);
    return stamp;
  }

  get(key: string): StateStamp | null {
    return this.stamps.get(key) ?? null;
  }

  /** Forget agents that are gone, so a pane that comes back later starts as first sight. */
  retain(liveKeys: ReadonlySet<string>): void {
    for (const key of [...this.stamps.keys()]) if (!liveKeys.has(key)) this.stamps.delete(key);
  }
}
