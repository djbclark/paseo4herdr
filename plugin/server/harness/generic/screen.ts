import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { PaneReadResultSchema } from "../../herdr/schema.js";
import type { HerdrRequestFn, PaneObservation, TranscriptReader, TranscriptSnapshot } from "../types.js";

/**
 * Generic (pane-bound) timeline: the pane's screen is not an append-only transcript, so it is shown as ONE mutable row
 * with a fixed id, preceded by an in-memory ledger of the prompts Paseo sent to this pane.
 *
 * Invariants the core relies on:
 * - the screen row id never changes, so a changed screen re-emits the same id (the core diffs by id + content hash);
 * - `extendsPrevious` is always true and `chainIds` is empty, so a rewritten screen never reads as a "branched" freeze;
 * - `snapshot()` never throws: a throw from a reader is a disconnect for the live loop, and an unreadable screen is not
 *   a disconnected pane.
 */

/**
 * `visible`, not `recent`: for an idle agent running on the alternate screen, Herdr satisfies a `recent` read taller
 * than the viewport by scrolling the live TUI with wheel reports (herdr src/server/headless.rs, `alt_screen_read_spec`).
 * This reader runs on every reconcile, so that would nudge the user's terminal every couple of seconds.
 */
export const SCREEN_SOURCE = "visible";
/** Prompts remembered per pane; older ones drop off the front (ids keep counting up). */
const MAX_LEDGER_ENTRIES = 50;

interface LedgerEntry { n: number; text: string; at: string }

class PromptLedger {
  readonly entries: LedgerEntry[] = [];
  private next = 1;
  record(text: string, at: string): void {
    this.entries.push({ n: this.next++, text, at });
    if (this.entries.length > MAX_LEDGER_ENTRIES) this.entries.splice(0, this.entries.length - MAX_LEDGER_ENTRIES);
  }
}

/**
 * Keyed by the session's pinned Herdr request function (`PaneObservation.request` and the `submitPrompt` context's
 * `request` are the same function for one session), then by terminal: a session on another Herdr socket never sees
 * these prompts, and the ledger dies with its session. It is deliberately not persisted (a reopened chat shows only the screen).
 */
const ledgers = new WeakMap<HerdrRequestFn, Map<string, PromptLedger>>();

function ledgerFor(request: HerdrRequestFn, terminalId: string): PromptLedger {
  let byTerminal = ledgers.get(request);
  if (!byTerminal) { byTerminal = new Map(); ledgers.set(request, byTerminal); }
  let ledger = byTerminal.get(terminalId);
  if (!ledger) { ledger = new PromptLedger(); byTerminal.set(terminalId, ledger); }
  return ledger;
}

/** Remember a prompt Paseo delivered to `terminalId`; shown as a `user_message` row before the screen row. */
export function recordSubmittedPrompt(request: HerdrRequestFn, terminalId: string, text: string, now: Date = new Date()): void {
  ledgerFor(request, terminalId).record(text, now.toISOString());
}

export const screenRowId = (terminalId: string): string => `generic:${terminalId}:screen`;
export const promptRowId = (terminalId: string, n: number): string => `generic:${terminalId}:user:${n}`;

/** Trailing whitespace and blank edge lines carry no information and would churn the content hash. */
function tidyScreen(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

/** A fenced block whose fence is longer than any backtick run inside, so screen content can't close it early. */
function fenced(body: string): string {
  if (!body) return "(the pane screen is empty)";
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${body}\n${fence}`;
}

async function readScreen(observation: PaneObservation, signal: AbortSignal | undefined): Promise<string | null> {
  const paneId = observation.paneId();
  if (!paneId || observation.signal.aborted) return null;
  try {
    const result = await observation.request("pane.read", { pane_id: paneId, source: SCREEN_SOURCE, strip_ansi: true },
      { signal: signal ? AbortSignal.any([observation.signal, signal]) : observation.signal });
    const parsed = PaneReadResultSchema.safeParse(result);
    return parsed.success ? tidyScreen(parsed.data.read.text) : null;
  } catch {
    return null;
  }
}

export function openScreenReader(observation: PaneObservation): TranscriptReader {
  let lastScreen: { text: string; at: string } | null = null;
  return {
    async snapshot(signal?: AbortSignal): Promise<TranscriptSnapshot> {
      const text = await readScreen(observation, signal);
      // A failed read keeps the last good screen (or none yet): the pane is not known to be gone, only unreadable now.
      if (text !== null) lastScreen = { text, at: new Date().toISOString() };
      const terminalId = observation.terminalId;
      const items: ProviderTimelineItem[] = [];
      const timestamps: Record<string, string> = {};
      for (const entry of ledgerFor(observation.request, terminalId).entries) {
        const id = promptRowId(terminalId, entry.n);
        items.push({ id, type: "user_message", text: entry.text });
        timestamps[id] = entry.at;
      }
      if (lastScreen) {
        const id = screenRowId(terminalId);
        items.push({ id, type: "assistant_message", text: fenced(lastScreen.text) });
        timestamps[id] = lastScreen.at;
      }
      return {
        items,
        timestamps,
        ...(lastScreen ? { updatedAt: lastScreen.at } : {}),
        chainHead: null,
        chainIds: [],
        turnState: "idle",
        extendsPrevious: () => true,
      };
    },
    subscribe: () => () => {},
    close(): void {},
  };
}
