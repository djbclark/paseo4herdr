import type { PaneProcessInfo } from "./herdr/schema.js";
import type { ShellSupport } from "./harness/types.js";

/**
 * What a pane's foreground says about a shell bound with `allowShell`:
 * - `idle`: the foreground group leader is the shell itself (its pid is the group), so a typed line would be read as a command;
 * - `busy`: another process group holds the foreground (a command is running), so typed text would go to that program;
 * - `exec`: the shell's own pid now runs something that is not a shell (`exec vim`), so it is no longer the bound shell;
 * - `unknown`: Herdr did not say enough (no shell pid or foreground group, or the leader is not listed).
 */
export type ShellForeground = "idle" | "busy" | "exec" | "unknown";

export function shellForeground(shell: ShellSupport, process: PaneProcessInfo): ShellForeground {
  const shellPid = process.shell_pid;
  const group = process.foreground_process_group_id;
  if (!shellPid || !group) return "unknown";
  if (group !== shellPid) return "busy";
  const leader = process.foreground_processes.find((candidate) => candidate.pid === group);
  if (!leader) return "unknown";
  return shell.isShell(leader) ? "idle" : "exec";
}

/**
 * One prompt is one command line: a newline would run several commands for one confirmed prompt, and any other
 * control character (ESC, Ctrl+C, a bracketed-paste marker) is a keystroke, not text. Returns why the text is refused, or null.
 */
export function shellTextProblem(text: string): string | null {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)
    ? "A shell prompt must be a single line of plain text; no newline or control character is allowed. Nothing was typed."
    : null;
}
