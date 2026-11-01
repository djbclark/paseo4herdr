import type { PaneProcessInfo } from "./herdr/schema.js";
import type { ShellSupport } from "./harness/types.js";

/**
 * What a pane's foreground says about a shell bound with `allowShell`:
 * - `idle`: the foreground group is exactly the interactive shell itself, so a typed line would be read as a command;
 * - `busy`: another process group, or another process in the shell's own group (job control off), holds the foreground, so typed text would go to that program;
 * - `exec`: the shell's own pid now runs something that is not an interactive command shell (`exec vim`, `exec tmux`, `bash script.sh`), so it is no longer the bound shell;
 * - `unknown`: Herdr did not say enough (no shell pid or foreground group, or the leader is not listed).
 */
export type ShellForeground = "idle" | "busy" | "exec" | "unknown";

/**
 * Longest line typed into a shell. Shells without a line editor or bracketed paste (dash, plain `sh`) read in canonical
 * mode and drop input past MAX_CANON (1024 on macOS); Enter would then run a truncated command.
 */
export const SHELL_TEXT_MAX_BYTES = 1000;

/** True when a shell's argv carries an operand (`bash deploy.sh`, `sh -c cmd`): it runs something, it does not read commands. */
function runsOperand(argv: readonly string[] | null | undefined): boolean {
  return !!argv && argv.slice(1).some((arg) => !arg.startsWith("-"));
}

/**
 * Idle needs three things: the foreground group is the shell's own pid, that group holds exactly the shell (with job
 * control off a child shares the shell's group), and the shell is interactive (no script or `-c` operand).
 */
export function shellForeground(shell: ShellSupport, process: PaneProcessInfo): ShellForeground {
  const shellPid = process.shell_pid;
  const group = process.foreground_process_group_id;
  if (!shellPid || !group) return "unknown";
  if (group !== shellPid) return "busy";
  const leader = process.foreground_processes.find((candidate) => candidate.pid === group);
  if (!leader) return "unknown";
  if (!shell.isShell(leader) || runsOperand(leader.argv)) return "exec";
  return process.foreground_processes.every((candidate) => candidate.pid === shellPid) ? "idle" : "busy";
}

/**
 * One prompt is one command line: a newline would run several commands for one confirmed prompt, and any other
 * control character (ESC, Ctrl+C, a bracketed-paste marker) is a keystroke, not text. Returns why the text is refused, or null.
 */
export function shellTextProblem(text: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) {
    return "A shell prompt must be a single line of plain text; no newline or control character is allowed. Nothing was typed.";
  }
  if (Buffer.byteLength(text, "utf8") > SHELL_TEXT_MAX_BYTES) {
    return `A shell prompt is limited to ${SHELL_TEXT_MAX_BYTES} bytes: a longer line can be cut short by the terminal and run as a different command. Nothing was typed.`;
  }
  return null;
}
