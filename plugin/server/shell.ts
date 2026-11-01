import type { PaneProcessInfo } from "./herdr/schema.js";
import type { ShellSupport } from "./harness/types.js";

/**
 * What a pane's foreground says about a shell bound with `allowShell`:
 * - `idle`: the foreground group is exactly the interactive shell itself, so a typed line would be read as a command;
 * - `busy`: another process group, or another process in the shell's own group (job control off), holds the foreground, so typed text would go to that program;
 * - `exec`: the shell's own pid now runs something that is not an interactive command shell (`exec vim`, `exec tmux`, `bash script.sh`), so it is no longer the bound shell;
 * - `unknown`: Herdr or `ps` did not say enough (no shell pid or foreground group, the leader is not listed or has no argv, or `ps` failed).
 */
export type ShellForeground = "idle" | "busy" | "exec" | "unknown";

/**
 * Longest line typed into a shell. Shells without a line editor or bracketed paste (dash, plain `sh`) read in canonical
 * mode and drop input past MAX_CANON (1024 on macOS); Enter would then run a truncated command.
 */
export const SHELL_TEXT_MAX_BYTES = 1000;

/**
 * Herdr's own view of the foreground, which is synchronous and not enough for `idle` (see {@link checkedShellForeground}).
 * It can only say `idle` ("the report looks idle"): the foreground group is the shell's own pid, the shell is interactive
 * (no script or `-c` operand) and Herdr lists no other member. A leader without argv is `unknown`, never idle: Herdr omits
 * argv when it cannot read it (an exiting process, another uid), and `bash deploy.sh` would read as an interactive shell.
 */
export function shellForeground(shell: ShellSupport, process: PaneProcessInfo): ShellForeground {
  const shellPid = process.shell_pid;
  const group = process.foreground_process_group_id;
  if (!shellPid || !group) return "unknown";
  if (group !== shellPid) return "busy";
  const leader = process.foreground_processes.find((candidate) => candidate.pid === group);
  if (!leader) return "unknown";
  if (!shell.isShell(leader)) return "exec";
  if (!leader.argv || leader.argv.length === 0) return "unknown";
  // An operand (`bash deploy.sh`, `sh -c cmd`) means the shell runs something; it does not read commands.
  if (leader.argv.slice(1).some((arg) => !arg.startsWith("-"))) return "exec";
  return process.foreground_processes.every((candidate) => candidate.pid === shellPid) ? "idle" : "busy";
}

/**
 * Idle only when `ps` agrees that the shell is the only process in its group. On macOS Herdr drops every process it cannot
 * read (root, setuid: `sudo`, `su`, and their root children) from `foreground_processes`, so with job control off
 * `sudo vim` in the shell's group is reported as the shell alone. `ps -A` lists them. A `ps` failure or an unparseable
 * listing is `unknown`; a second member is `busy`.
 */
export async function checkedShellForeground(shell: ShellSupport, process: PaneProcessInfo): Promise<ShellForeground> {
  const reported = shellForeground(shell, process);
  if (reported !== "idle") return reported;
  const shellPid = process.shell_pid!;
  let members: number[];
  try { members = await shell.groupMembers(shellPid); } catch { return "unknown"; }
  if (!members.includes(shellPid)) return "unknown";
  return members.length === 1 ? "idle" : "busy";
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
