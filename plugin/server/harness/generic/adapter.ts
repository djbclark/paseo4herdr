import type { HarnessAdapter, PromptDelivery, TranscriptLocator, TranscriptReader } from "../types.js";
import type { PaneProcessInfo } from "../../herdr/schema.js";
import { classifyHerdrPrompt } from "../../prompt.js";
import { processInstanceId } from "../process-identity.js";
import { openScreenReader, recordSubmittedPrompt } from "./screen.js";

/**
 * Generic adapter: any Herdr-detected agent kind that has no dedicated adapter, bound by pane (no native session ref).
 * Timeline = the pane's screen (see screen.ts); turns end on Herdr's status counters (`turnEvidence: "status"`);
 * prompts go through Herdr's `agent.prompt`, which refuses an unknown agent, a blocked agent or a pane whose
 * foreground process is not the agent before writing anything. No launch, restart, model, fork or approval support.
 * Approvals stay in the terminal: Herdr `blocked` raises the core's "needs approval in the terminal" notice.
 */
/** Foreground leaders that execute whatever is typed at them as commands. Prompt text must never reach one. */
const SHELLS: Record<string, true> = Object.fromEntries(
  ["bash", "zsh", "fish", "sh", "dash", "ash", "ksh", "csh", "tcsh", "nu", "pwsh", "xonsh", "elvish", "login", "tmux", "screen", "zellij"].map((name) => [name, true]),
);

/** `-zsh` (login shell), `/bin/zsh` and `zsh` all name the shell `zsh`. */
const programName = (value: string | null | undefined): string => (value ?? "").replace(/^.*\//, "").replace(/^-/, "");

export const isShellProcess = (process: { name: string; argv0?: string | null }): boolean =>
  Object.hasOwn(SHELLS, programName(process.name)) || Object.hasOwn(SHELLS, programName(process.argv0));

export const genericAdapter: HarnessAdapter = {
  id: "generic",
  label: "Generic",
  nativeKinds: "any",
  herdrIntegration: null,
  binding: "pane",
  turnEvidence: "status",
  // No `launch`, `resumeArgs`, `readConfig`, `configure`, approvals or forks: import/bind only.
  /** Pane-bound: the locator needs the live pane. Without one the pane can't be read and the chat opens read-only. */
  resolveTranscript: async (_ref, ctx) => ctx.pane
    ? { path: `herdr-pane:${ctx.pane.terminalId}`, nativeSessionKey: ctx.pane.terminalId, pane: ctx.pane }
    : null,
  nativeSessionKey: (ref) => ref.value,
  openTranscript: (locator: TranscriptLocator): TranscriptReader => {
    if (!locator.pane) throw new Error("The generic adapter reads a pane; the locator carries none.");
    return openScreenReader(locator.pane);
  },
  /**
   * Identity is pid + process start time. A `ps` failure throws and means "cannot validate": the core rejects the
   * prompt (or disconnects), it never reads the failure as "the process was replaced".
   */
  inspectInput: async ({ pid }) => ({ pid, instanceId: await processInstanceId(pid) }),
  submitPrompt: async (target, text, { signal, request }): Promise<PromptDelivery> => {
    const expectation = { terminalId: target.terminalId, sessionRef: null, accepts: () => true };
    let delivery: PromptDelivery;
    try {
      delivery = classifyHerdrPrompt(await request("agent.prompt", { target: target.paneId, text }, { signal }), undefined, expectation);
    } catch (error) {
      // A timeout or any error not proven to precede the write is `uncertain` and is never resent.
      delivery = classifyHerdrPrompt(undefined, error, expectation);
    }
    if (delivery.type === "accepted") recordSubmittedPrompt(request, target.terminalId, text);
    return delivery;
  },
  interruptKeys: ["esc"],
  // Esc interrupts the agents Herdr detects; with no detected kind nothing says what Esc would do, so no key is sent.
  interruptKeysFor: (kind) => kind ? ["esc"] : [],
  promptWhileWorking: "reject",
  isOccupant: (proc: PaneProcessInfo): boolean => {
    const pgid = proc.foreground_process_group_id;
    const leader = pgid ? proc.foreground_processes.find((candidate) => candidate.pid === pgid) : undefined;
    return !!leader && !isShellProcess(leader);
  },
  blockedHint: "The agent needs approval in the terminal — run: herdr agent attach <target>",
};
