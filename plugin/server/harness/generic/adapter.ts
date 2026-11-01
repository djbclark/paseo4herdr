import type { HarnessAdapter, PromptDelivery, ShellSupport, TranscriptLocator, TranscriptReader } from "../types.js";
import { PaneProcessInfoResultSchema, type PaneProcessInfo } from "../../herdr/schema.js";
import { HerdrError } from "../../herdr/client.js";
import { classifyHerdrPrompt } from "../../prompt.js";
import { checkedShellForeground, shellTextProblem } from "../../shell.js";
import { processGroupMembers, processInstanceId } from "../process-identity.js";
import { openScreenReader, recordSubmittedPrompt } from "./screen.js";

/**
 * Generic adapter: any Herdr-detected agent kind that has no dedicated adapter, bound by pane (no native session ref).
 * Timeline = the pane's screen (see screen.ts); turns end on Herdr's status counters (`turnEvidence: "status"`);
 * prompts go through Herdr's `agent.prompt`, which refuses an unknown agent, a blocked agent or a pane whose
 * foreground process is not the agent before writing anything. No launch, restart, model, fork or approval support.
 * Approvals stay in the terminal: Herdr `blocked` raises the core's "needs approval in the terminal" notice.
 */
/** Foreground leaders that execute whatever is typed at them as commands: the only processes typed into. */
const COMMAND_SHELLS: Record<string, true> = Object.fromEntries(
  ["bash", "zsh", "fish", "sh", "dash", "ash", "ksh", "csh", "tcsh", "nu", "pwsh", "xonsh", "elvish"].map((name) => [name, true]),
);
/** Programs that are never agents but must not be typed into either: a multiplexer forwards text to whatever runs inside it, `login` reads a user name and password. */
const NOT_AGENTS: Record<string, true> = Object.fromEntries(["login", "tmux", "screen", "zellij"].map((name) => [name, true]));

/** `-zsh` (login shell), `/bin/zsh` and `zsh` all name the shell `zsh`. */
const programName = (value: string | null | undefined): string => (value ?? "").replace(/^.*\//, "").replace(/^-/, "");

/** Kernel process name only: `argv0` is whatever a program chose to be started as (`exec -a zsh vim`). */
export const isShellProcess = (process: { name: string }): boolean => Object.hasOwn(COMMAND_SHELLS, programName(process.name));
/** Refusal only (never a reason to type): a spoofed argv0 can at worst make a program look like a shell, which refuses it. */
const isNotAgent = (process: { name: string; argv0?: string | null }): boolean =>
  [process.name, process.argv0].some((value) => Object.hasOwn(COMMAND_SHELLS, programName(value)) || Object.hasOwn(NOT_AGENTS, programName(value)));

/** What clears the shell's command line before a prompt is typed: end of line, then kill-line (emacs keymaps; canonical-mode shells kill the line with Ctrl+U). Vi-mode shells in command mode may keep text. */
const CLEAR_LINE_KEYS = ["ctrl+e", "ctrl+u"];

/** Errors Herdr raises before it writes anything to the pane. */
const BEFORE_WRITE: Record<string, true> = { pane_not_found: true, invalid_params: true };

/**
 * Shell opt-in (a binding's `allowShell`): one prompt is one command line, typed with `pane.send_text` and submitted with
 * an Enter key. `agent.prompt` refuses a pane with no detected agent, so it is not used. Only a shell that is idle at its
 * prompt (foreground group is the shell itself) is typed into, re-checked right before the write.
 */
const shellSupport: ShellSupport = {
  isShell: isShellProcess,
  interruptKeys: ["ctrl+c"],
  notice: "Prompt text runs as shell commands.",
  groupMembers: (pgid) => processGroupMembers(pgid),
  submit: async (target, text, { signal, request, stillAllowed, allowedNow }): Promise<PromptDelivery> => {
    const problem = shellTextProblem(text);
    if (problem) return { type: "rejected", message: problem };
    const refused = { type: "rejected", message: "Shell input was turned off; nothing was typed." } as const;
    // The one async settings read comes first. From the foreground check to the last write only `allowedNow` (no I/O) is used,
    // so the window in which the pane can change under us is as short as the requests themselves.
    if (!(await stillAllowed())) return refused;
    /** Null when the shell is at an idle prompt right now: Herdr's own report and `ps` (which sees the root processes Herdr hides) agree. */
    const notIdle = async (): Promise<PromptDelivery | null> => {
      try {
        const process = PaneProcessInfoResultSchema.parse(await request("pane.process_info", { pane_id: target.paneId }, { signal })).process_info;
        if (process.shell_pid !== target.pid || (await checkedShellForeground(shellSupport, process)) !== "idle") {
          return { type: "rejected", message: "The shell is not at an idle prompt; nothing was typed." };
        }
      } catch {
        return { type: "rejected", message: "Paseo could not check that the shell is at an idle prompt; nothing was typed." };
      }
      return null;
    };
    const beforeClear = await notIdle();
    if (beforeClear) return beforeClear;
    if (!allowedNow()) return refused;
    // Anything left in the line editor (an earlier half-typed line) would be glued to this prompt and run with it.
    try {
      await request("pane.send_keys", { pane_id: target.paneId, keys: CLEAR_LINE_KEYS }, { signal });
    } catch (error) {
      return { type: "rejected", message: `Paseo could not clear the shell's command line, so nothing was typed (${error instanceof Error ? error.message : String(error)})` };
    }
    // The clear keys may have reached a program the user started meanwhile: look again before typing a prompt into it.
    const afterClear = await notIdle();
    if (afterClear) return afterClear;
    if (!allowedNow()) return refused;
    try {
      await request("pane.send_text", { pane_id: target.paneId, text }, { signal });
    } catch (error) {
      if (error instanceof HerdrError && Object.hasOwn(BEFORE_WRITE, error.code)) return { type: "rejected", message: error.message };
      return { type: "uncertain", message: `Typing the command may have partly reached the shell (${error instanceof Error ? error.message : String(error)})` };
    }
    // A switch that landed while the text was in flight: leave the text on the line for the user to see, never press Enter.
    if (!allowedNow()) return { type: "uncertain", message: "Shell input was turned off while the command was being typed; Enter was not pressed and the text may still be on the command line" };
    try {
      await request("pane.send_keys", { pane_id: target.paneId, keys: ["enter"] }, { signal });
    } catch (error) {
      // The text is at the prompt and Enter may or may not have been pressed: never type or press it again.
      return { type: "uncertain", message: `The command was typed but Enter may not have been pressed (${error instanceof Error ? error.message : String(error)})` };
    }
    recordSubmittedPrompt(request, target.terminalId, text);
    return { type: "accepted" };
  },
};

export const genericAdapter: HarnessAdapter = {
  id: "generic",
  label: "Generic",
  nativeKinds: "any",
  herdrIntegration: null,
  binding: "pane",
  turnEvidence: "status",
  shell: shellSupport,
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
    // Only the agent kind seen at validation counts: a reply naming another kind is not this pane's agent.
    const expectation = { terminalId: target.terminalId, sessionRef: null, accepts: (kind: string | null | undefined) => (kind ?? null) === (target.agentKind ?? null) };
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
    return !!leader && !isNotAgent(leader);
  },
  blockedHint: "The agent needs approval in the terminal — run: herdr agent attach <target>",
};
