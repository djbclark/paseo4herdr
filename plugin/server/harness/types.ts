import type { ProviderSessionConfig, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { AgentSessionRef, PaneProcessInfo } from "../herdr/schema.js";

export type NativeTurnEnd = "completed" | "aborted" | "error" | "unknown";

/**
 * How a session learns that a native turn ended: by reading the transcript, from Herdr's agent status alone, or
 * (a shell binding only) from the pane's foreground process: working while a child holds the foreground, ended
 * when the foreground returns to the shell. "process" is never an adapter's own `turnEvidence`; a session switches to it
 * for a binding whose occupant is an opted-in shell.
 */
export type TurnEvidence = "transcript" | "status" | "process";

/** How a session binds to its agent: a native session ref, or the pane itself. */
export type BindingMode = "native-ref" | "pane";

/** One Herdr request on a pinned connection/daemon (the session deps' `request`). */
export type HerdrRequestFn = (method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>;

/**
 * Per-session pinned view of one Herdr pane. Never another daemon's: `request` is the connection the session
 * opened, and `signal` covers the session lifetime (or a discovery-scoped snapshot).
 */
export interface PaneObservation {
  readonly terminalId: string;
  readonly herdrSession: string | null;
  /** Current pane id; follows pane moves. */
  paneId(): string | null;
  /** The session's pinned Herdr request. */
  request: HerdrRequestFn;
  /** Session lifetime (or a discovery-scoped one). */
  readonly signal: AbortSignal;
}

export interface TranscriptLocator {
  path: string;
  nativeSessionKey: string;
  /** Live pane view for pane-bound sessions; adapters must not persist the locator. */
  pane?: PaneObservation;
}
export interface TranscriptSnapshot {
  items: ProviderTimelineItem[];
  timestamps: Readonly<Record<string, string>>;
  title?: string;
  updatedAt?: string;
  chainHead: string | null;
  chainIds: readonly string[];
  /** Native state, never inferred from the last display row. */
  turnState: "idle" | "working" | "unknown";
  lastTurnEnd?: NativeTurnEnd;
  lastTurnEndId?: string;
  /** P3.5: last user-selected model (`provider/id`) from the active chain; undefined when the chain records none. */
  model?: string;
  /** P3.5: last recorded thinking level (`null` = off/cleared); undefined when the chain records none (use the live config). */
  thinkingLevel?: string | null;
  extendsPrevious(previous: TranscriptSnapshot): boolean;
}

/** P3.5 model and thinking selection (contract frozen 2026-10-12 from the P3.5 spike). */
export interface HarnessModel {
  /** Exact id Paseo shows and sends back, e.g. `provider/id`. */
  id: string;
  label: string;
  provider: string;
  /** Allowed thinking levels; empty for a model without reasoning. `off` is implied for reasoning models. */
  thinkingLevels: readonly string[];
  defaultThinkingLevel?: string;
  contextWindow?: number;
}
export interface HarnessConfig {
  model: string | null;
  /** Resolved current level (`null` when the model has no reasoning or it is off). */
  thinkingLevel: string | null;
  models: readonly HarnessModel[];
}
export type ConfigureResult =
  | { type: "configured"; config: HarnessConfig }
  | { type: "rejected"; code: string; message: string }
  | { type: "uncertain"; message: string };
export interface ConfigTarget { pid: number; ref: AgentSessionRef; instanceId: string; }

/** P3.6 approvals and questions (contract frozen 2026-10-14). Ids are opaque, harness-issued and never reused. */
export interface PendingApproval {
  id: string;
  kind: "tool";
  toolName: string;
  /** The harness's own dialog title, e.g. `Allow tool: bash`. */
  title: string;
  reason?: string;
  /** Tool arguments; `{ truncated: true }` when too large to ship. */
  args?: unknown;
  approvalMode?: string;
  createdAt: string;
}
export interface PendingQuestionItem {
  id: string;
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multi: boolean;
  recommended?: number;
}
export interface PendingQuestion {
  id: string;
  kind: "question";
  toolName: string;
  questions: PendingQuestionItem[];
  createdAt: string;
}
export type PendingDecision = PendingApproval | PendingQuestion;
export type DecisionOutcome = "approved" | "denied" | "answered" | "cancelled" | "timed_out" | "chat";
export type DecisionSource = "paseo" | "terminal" | "system";
export interface QuestionAnswer { id: string; selectedOptions: string[]; customInput?: string; }
export interface DecisionRecord {
  /** Monotonic per harness instance; snapshots return records with `seq > cursor`. */
  seq: number;
  id: string;
  kind: "tool" | "question";
  outcome: DecisionOutcome;
  source: DecisionSource;
  answer?: QuestionAnswer[];
  at: string;
}
export interface ApprovalSnapshot {
  pending: PendingDecision[];
  outcomes: DecisionRecord[];
  cursor: number;
  /** The requested cursor predates the oldest retained outcome: some outcomes were dropped. */
  lost: boolean;
}
export type Decision =
  | { type: "allow" }
  | { type: "deny" }
  | { type: "answer"; answers: QuestionAnswer[] }
  | { type: "chat" };
export type ResolveResult =
  | { type: "resolved"; outcome: DecisionRecord }
  | { type: "rejected"; code: string; message: string; outcome?: DecisionRecord }
  | { type: "uncertain"; message: string };
/** P3.5B: a sibling native session forked off ours by another process. */
export interface NativeFork { path: string; sessionId: string; }
export interface TranscriptReader {
  /** `signal` aborts an in-flight re-read; readers may ignore it. */
  snapshot(signal?: AbortSignal): Promise<TranscriptSnapshot>;
  /** Notify when the underlying transcript may have changed (P2A live sync). */
  subscribe(listener: () => void): () => void;
  close(): void;
}
export type PromptDelivery =
  | { type: "accepted" }
  | { type: "rejected"; message: string }
  | { type: "uncertain"; message: string };
/** "unknown" = the harness could not tell (transport failure, identity mismatch, unrecognized reply). */
export type RestoredPromptOutcome = "cleared" | "kept" | "unknown" | "unsupported";
/**
 * Optional shell opt-in: a binding with `allowShell` set may be bound to a plain shell pane, and prompt text then runs
 * as commands. Absent = shells are refused (`isOccupant` false for a shell leader).
 */
export interface ShellSupport {
  /**
   * Whether this foreground process is a command shell that executes whatever is typed at it. Judged by the kernel process
   * name only: argv0 is whatever the program was started as (`exec -a zsh vim`). A multiplexer or `login` is not a shell.
   */
  isShell(process: { name: string }): boolean;
  /** Keys that stop a command running in the foreground; never sent while the shell itself is idle. */
  readonly interruptKeys: readonly string[];
  /** Shown when the binding opens with the flag on and with every accepted prompt. */
  readonly notice: string;
  /**
   * Type one line and press Enter. A `rejected` result wrote nothing; an error or timeout after any write is `uncertain`
   * and the prompt is never resent.
   */
  submit(target: InputTarget & { instanceId: string; paneId: string; terminalId: string }, text: string, ctx: {
    signal: AbortSignal;
    request(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
    /** Whether shell input is still allowed (kill switch, plugin setting, session generation). Checked before any write. */
    stillAllowed(): Promise<boolean>;
  }): Promise<PromptDelivery>;
}
export interface InputTarget {
  pid: number;
  /** Null only when the adapter's binding mode is "pane". */
  ref: AgentSessionRef | null;
  /** Herdr's `agent` kind for the bound pane as last validated (null = none detected). */
  agentKind?: string | null;
  /** Present for pane-bound sessions; process info as last validated. */
  pane?: { paneId: string; terminalId: string; process: PaneProcessInfo };
}
/** How to start a new agent of this harness; absent = the harness is import/bind only. */
export interface LaunchSpec {
  /** Herdr `agent.start` kind; distinct from the adapter id, which owns persistence. */
  readonly kind: string;
  args(config: ProviderSessionConfig): string[];
}
export interface HarnessAdapter {
  /** Persistence owner and `herdr-<id>` provider prefix (unchanged). */
  readonly id: string;
  readonly label: string;
  /** Plugin-directory-relative path to a self-contained SVG; Paseo shows it beside this harness's chats and import rows. */
  readonly icon?: string;
  /** Herdr `agent` values this adapter claims for new work; "any" = the fallback adapter. */
  readonly nativeKinds: readonly string[] | "any";
  /** Herdr integration this adapter requires; null = no integration required. */
  readonly herdrIntegration: string | null;
  /** Launch description; absent = import/bind only. */
  readonly launch?: LaunchSpec;
  /** How sessions bind to their agent: a native session ref, or the pane itself. */
  readonly binding: BindingMode;
  /** How a session learns that a native turn ended. */
  readonly turnEvidence: TurnEvidence;
  resolveTranscript(ref: AgentSessionRef | null, ctx: { cwd: string; pane?: PaneObservation }): Promise<TranscriptLocator | null>;
  nativeSessionKey(ref: AgentSessionRef): string;
  openTranscript(locator: TranscriptLocator): TranscriptReader;
  /** Process-local input endpoint; identity survives pane moves, not process replacement. */
  inspectInput(target: InputTarget, signal?: AbortSignal): Promise<{ pid: number; instanceId: string }>;
  submitPrompt(target: InputTarget & { instanceId: string; paneId: string; terminalId: string }, text: string, ctx: {
    signal: AbortSignal;
    request(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
  }): Promise<PromptDelivery>;
  readonly interruptKeys: readonly string[];
  /**
   * Optional: keys that stop a turn of a pane whose Herdr `agent` kind is `kind`, for an adapter that serves several
   * kinds. Absent = `interruptKeys`. An empty list means Stop is refused for that kind (no key is sent).
   */
  interruptKeysFor?(kind: string | null | undefined): readonly string[];
  readonly promptWhileWorking: "reject";
  isOccupant(proc: PaneProcessInfo): boolean;
  /** Optional shell opt-in (see {@link ShellSupport}); only a binding with `allowShell` uses it. */
  readonly shell?: ShellSupport;
  readonly blockedHint: string;
  /** Optional: input companion install check; a not-ok result keeps import read-only. */
  inputCompanionStatus?(): Promise<{ ok: boolean; diagnostic?: string }>;
  /** P3.5A: live model/thinking state and the install-wide model list. */
  readConfig?(target: ConfigTarget, signal?: AbortSignal): Promise<HarnessConfig>;
  /** P3.5A: change model and/or thinking level; only while idle; validates exactly, applies nothing on refusal. */
  configure?(target: ConfigTarget, changes: { model?: string; thinkingLevel?: string }, signal?: AbortSignal): Promise<ConfigureResult>;
  /** Optional: arguments that reopen `ref` in a fresh process (in-place restart, R35). Without it the harness can't be restarted from Paseo. */
  resumeArgs?(ref: AgentSessionRef): string[];
  /** Optional: cheap check (no round trip) that process `pid` has its input endpoint; false means it started without the companion. */
  inputReachable?(pid: number): Promise<boolean>;
  /**
   * Optional: a turn Paseo submitted was aborted before the harness recorded it, and the harness may have put the prompt
   * text back into its input box. Clear it only if the box holds exactly `text`; never touch anything else. Called at most
   * once per canceled turn, never retried. "unsupported" = this harness/companion cannot tell (older companion).
   */
  discardRestoredPrompt?(target: InputTarget & { instanceId: string }, text: string, signal?: AbortSignal): Promise<RestoredPromptOutcome>;
  /** P3.5B: sibling sessions whose header names `locator`'s session as their parent (excluding `locator` itself). */
  findForks?(locator: TranscriptLocator, signal?: AbortSignal): Promise<NativeFork[]>;
  /**
   * P3.6: pending approvals/questions plus outcomes after `cursor` (null = from the start). "unsupported" = the
   * companion predates approvals; the session falls back to the terminal-only notice.
   */
  snapshotApprovals?(target: ConfigTarget, cursor: number | null, signal?: AbortSignal): Promise<ApprovalSnapshot | "unsupported">;
  /** P3.6: decide one pending entry. Never retried: refusals are definite only before the write; after it, "uncertain". */
  resolveApproval?(target: ConfigTarget, id: string, decision: Decision, signal?: AbortSignal): Promise<ResolveResult>;
}

