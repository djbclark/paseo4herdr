const SHELL_SAFE = /^[A-Za-z0-9_.@%+=:,\/-]+$/;
const shellQuote = (value: string): string => SHELL_SAFE.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
const herdrCommand = (herdrSession: string | null): string => `herdr${herdrSession ? ` --session ${shellQuote(herdrSession)}` : ""}`;
/** Command a user runs in a terminal to attach to a launched agent. */
export const attachCommand = (herdrSession: string | null, agentName: string): string =>
  `${herdrCommand(herdrSession)} agent attach ${shellQuote(agentName)}`;
/** Command a user runs in a terminal to read a pane's recent output (works after the agent is gone). */
export const paneReadCommand = (herdrSession: string | null, paneId: string): string =>
  `${herdrCommand(herdrSession)} pane read ${shellQuote(paneId)}`;
/** Argument list for `herdr [--session <name>] agent attach <target>`, for running without a shell. */
export const attachArgs = (herdrSession: string | null, agentName: string): string[] =>
  [...(herdrSession ? ["--session", herdrSession] : []), "agent", "attach", agentName];
/** Command a user runs in a terminal to open a pane that has no agent (`herdr terminal attach` takes the terminal id). */
export const terminalAttachCommand = (herdrSession: string | null, terminalId: string): string =>
  `${herdrCommand(herdrSession)} terminal attach ${shellQuote(terminalId)}`;
/** Argument list for `herdr [--session <name>] terminal attach <terminal id>`, for running without a shell. */
export const terminalAttachArgs = (herdrSession: string | null, terminalId: string): string[] =>
  [...(herdrSession ? ["--session", herdrSession] : []), "terminal", "attach", terminalId];
