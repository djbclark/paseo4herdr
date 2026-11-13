import { constants } from "node:fs";
import { lstat, open, readlink, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
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

const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MIN_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);
const DAY_MS = 86_400_000;

/**
 * A transcript timestamp, or null. Transcript text is untrusted (a pane chooses which file the plugin reads), so only a
 * strict ISO-8601 time of at most 40 characters between 2000 and tomorrow is accepted, and it is re-emitted in canonical form.
 */
export function cleanIso(value: unknown, nowMs: number = Date.now()): string | null {
  if (typeof value !== "string" || value.length > 40 || !STRICT_ISO.test(value)) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || parsed < MIN_PLAUSIBLE_MS || parsed > nowMs + DAY_MS) return null;
  return new Date(parsed).toISOString();
}

/** A model id: at most 200 characters from a conservative set, else null. */
export function cleanModel(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^[A-Za-z0-9._:/@+-]+$/.test(value) ? value : null;
}

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
    const at = cleanIso(entry.timestamp);
    if (entry.type === "session") {
      if (at && !next.sessionStartedAt) next.sessionStartedAt = at;
    } else if (entry.type === "model_change") {
      const recorded = cleanModel(entry.model);
      if (recorded) next.model = recorded;
    } else if (entry.type === "message") {
      const message = typeof entry.message === "object" && entry.message !== null ? (entry.message as Record<string, unknown>) : {};
      if (message.role === "assistant") {
        next.lastAssistantAt = laterIso(next.lastAssistantAt, at);
        const recorded = typeof message.provider === "string" && typeof message.model === "string" ? cleanModel(`${message.provider}/${message.model}`) : null;
        if (recorded) next.model = recorded;
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
export const FULL_READ_LIMIT = 4 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 1024 * 1024;
/** No single read allocates more than this: growth beyond it is folded from the tail window only. */
export const MAX_READ_BYTES = FULL_READ_LIMIT;
/** After a failed read, leave the file alone this long (an unchanged file stays left alone until it changes). */
const FAIL_BACKOFF_MS = 30_000;
const MAX_CONCURRENT_READS = 2;

/** Reads `[start, end)` through an already-open handle: the caller fstat'ed that handle, so there is no second open by name. */
async function readRange(handle: FileHandle, start: number, end: number): Promise<Buffer> {
  const length = Math.max(0, Math.min(end - start, MAX_READ_BYTES));
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}

/**
 * The complete lines of `data` and how many bytes they (with their newlines) cover; a trailing partial line is left out.
 * Positions are counted in the bytes that were read, never in the decoded text: invalid UTF-8 decodes to U+FFFD, which
 * re-encodes longer, so measuring the string would move the stored read position.
 */
function completeLines(data: Buffer): { lines: string[]; bytes: number } {
  const cut = data.lastIndexOf(0x0a);
  if (cut < 0) return { lines: [], bytes: 0 };
  return { lines: data.subarray(0, cut).toString("utf8").split("\n"), bytes: cut + 1 };
}

/**
 * Cheap, no-I/O test of a pane-reported path: absolute, short, `.jsonl`, and lexically inside one of `roots` once `..` is
 * folded away. Returns the normalised path, or null. Runs before any filesystem call, so a path that points at a slow or
 * hung mount is never touched.
 */
export function lexicallyInside(path: unknown, roots: readonly string[]): string | null {
  if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path) || !path.endsWith(".jsonl") || path.includes("\0")) return null;
  const normal = resolve(path);
  for (const root of roots) {
    const base = resolve(root);
    if (normal.startsWith(base.endsWith(sep) ? base : base + sep)) return normal;
  }
  return null;
}

/**
 * The real path of `path` when it is a `.jsonl` file inside one of `roots` (also resolved), else null. A symlink anywhere in
 * the path is resolved first, so one that points out of a root is refused.
 *
 * Residual: between this check and the later `open`, a process that can write inside the session directory could swap a
 * parent directory for a symlink. {@link TranscriptSummaryCache} narrows that to a double race (it compares the opened
 * handle with an `lstat` of the checked path, and on Linux with `/proc/self/fd`) but cannot close it on macOS, which has no
 * path-of-descriptor check we can use. What a winner gets is a regular file's existence, mtime, and any value of the strict
 * timestamp/model shape; the attacker already runs as the same user.
 */
export async function confinedSessionPath(path: string, roots: readonly string[]): Promise<string | null> {
  const normal = lexicallyInside(path, roots);
  if (!normal) return null;
  try {
    const real = await realpath(normal);
    for (const root of roots) {
      const realRoot = await realpath(root).catch(() => null);
      if (realRoot && real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return real;
    }
  } catch {
    // Missing or unreadable: no facts.
  }
  return null;
}

/** Runs at most `limit` tasks at once. */
class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try { return await task(); } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/**
 * Per-session-file summaries, cached by path plus mtime and size so a 4-second overview poll doesn't re-parse transcripts.
 * The path comes from a pane (untrusted), so it is confined to the harness's session directory, opened once without
 * following symlinks, and checked on that handle to be a regular file. A file that only grew is read from where the last
 * read stopped, never more than {@link MAX_READ_BYTES} at a time (a bigger jump folds the tail window only). Concurrent
 * callers share one read per file, at most two files are read at once, and a failed read is not retried until the file
 * changes or a backoff passes.
 */
export class TranscriptSummaryCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly failed = new Map<string, { size: number; mtimeMs: number; until: number }>();
  private readonly inflight = new Map<string, Promise<TranscriptRead | null>>();
  private readonly limiter = new Limiter(MAX_CONCURRENT_READS);
  /** Counts file reads and the bytes they asked for, for tests. */
  reads = 0;
  bytesRequested = 0;

  constructor(private readonly maxEntries = 256, private readonly clock: () => number = Date.now) {}

  /** `roots`: the directories a session file may live in. A path outside them (or not a regular file) has no facts. */
  async read(path: string, roots: readonly string[]): Promise<TranscriptRead | null> {
    // Lexical check first, with no I/O. Everything that touches the filesystem (realpath included) runs inside the
    // limiter and is shared per input path, so a hung mount can pin at most the limiter's slots, never the thread pool.
    const normal = lexicallyInside(path, roots);
    if (!normal) return null;
    const running = this.inflight.get(normal);
    if (running) return running;
    const task = this.limiter.run(async () => {
      const real = await confinedSessionPath(normal, roots);
      return real ? this.readOnce(real) : null;
    }).finally(() => this.inflight.delete(normal));
    this.inflight.set(normal, task);
    return task;
  }

  private async readOnce(path: string): Promise<TranscriptRead | null> {
    let handle: FileHandle;
    let checked;
    try {
      checked = await lstat(path);
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      this.entries.delete(path);
      return null;
    }
    try {
      const info = await handle.stat();
      // The handle must be the very file that was checked (a parent swapped after the check opens another inode), a regular
      // file, and not a second name for a file elsewhere (a hardlink out of the session directory).
      if (!info.isFile() || info.nlink !== 1 || info.dev !== checked.dev || info.ino !== checked.ino) return null;
      if (process.platform === "linux" && (await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null)) !== path) return null;
      const cached = this.entries.get(path);
      const fresh = (): TranscriptRead | null => cached ? { summary: cached.summary, mtime: new Date(info.mtimeMs).toISOString() } : null;
      if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return fresh();
      const failure = this.failed.get(path);
      if (failure && ((failure.size === info.size && failure.mtimeMs === info.mtimeMs) || this.clock() < failure.until)) return fresh();
      try {
        // Same size, new mtime: the harness rewrote a header line in place (title, padding); no message was added.
        const entry = cached && info.size === cached.size ? { ...cached }
          : cached && info.size > cached.size ? await this.extend(handle, cached, info.size)
          : await this.initial(handle, info.size);
        entry.size = info.size;
        entry.mtimeMs = info.mtimeMs;
        this.failed.delete(path);
        this.entries.delete(path);
        this.entries.set(path, entry);
        while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
        return { summary: entry.summary, mtime: new Date(info.mtimeMs).toISOString() };
      } catch {
        this.failed.set(path, { size: info.size, mtimeMs: info.mtimeMs, until: this.clock() + FAIL_BACKOFF_MS });
        while (this.failed.size > this.maxEntries) this.failed.delete(this.failed.keys().next().value as string);
        return fresh();
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async window(handle: FileHandle, start: number, end: number): Promise<Buffer> {
    this.reads++;
    this.bytesRequested += Math.min(end - start, MAX_READ_BYTES);
    return readRange(handle, start, end);
  }

  private async extend(handle: FileHandle, cached: CacheEntry, size: number): Promise<CacheEntry> {
    if (size - cached.offset > MAX_READ_BYTES) {
      // Grew by more than one read: keep what the head said and fold only the newest window.
      const tail = await this.tailWindow(handle, size);
      return { ...cached, offset: tail.offset, summary: foldTranscriptLines(cached.summary, tail.lines) };
    }
    const { lines, bytes } = completeLines(await this.window(handle, cached.offset, size));
    return { ...cached, offset: cached.offset + bytes, summary: foldTranscriptLines(cached.summary, lines) };
  }

  /** The newest {@link TAIL_BYTES} of the file, from its first whole line; offset = just past the last whole line (the end when there is none). */
  private async tailWindow(handle: FileHandle, size: number): Promise<{ lines: string[]; offset: number }> {
    const data = await this.window(handle, size - TAIL_BYTES, size);
    const firstNewline = data.indexOf(0x0a);
    if (firstNewline < 0) return { lines: [], offset: size };
    const afterFirst = data.subarray(firstNewline + 1);
    const tail = completeLines(afterFirst);
    return { lines: tail.lines, offset: size - (afterFirst.length - tail.bytes) };
  }

  private async initial(handle: FileHandle, size: number): Promise<CacheEntry> {
    if (size <= FULL_READ_LIMIT) {
      const { lines, bytes } = completeLines(await this.window(handle, 0, size));
      return { size, mtimeMs: 0, offset: bytes, summary: foldTranscriptLines(EMPTY_SUMMARY, lines) };
    }
    const head = completeLines(await this.window(handle, 0, HEAD_BYTES));
    const tail = await this.tailWindow(handle, size);
    return { size, mtimeMs: 0, offset: tail.offset, summary: foldTranscriptLines(foldTranscriptLines(EMPTY_SUMMARY, head.lines), tail.lines) };
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
