import { AgentInfoSchema, AgentListResultSchema, PaneListResultSchema, type AgentInfo } from "./schema.js";
import type { HerdrRequestFn } from "../harness/types.js";

export interface ListPaneTargetsOptions {
  /** Abort the in-flight `agent.list` request. */
  signal?: AbortSignal;
  /**
   * Also list `pane.list` panes that have no detected agent (plain shells), as synthetic entries with `agent: null`,
   * status `unknown` and the label {@link SHELL_LABEL}. Off by default: only a caller that has opted a binding
   * into shell input asks, so every other `agent.list` consumer sees exactly what it saw before.
   */
  includeShells?: boolean;
}

/** Shown beside a plain shell pane wherever it is listed: typed text executes as commands. */
export const SHELL_LABEL = "shell (runs as commands)";

/**
 * The panes Paseo can bind a harness session to: every `agent.list` entry (any agent kind or none), plus, only when
 * `includeShells` is set, the plain shell panes Herdr lists in `pane.list` but not in `agent.list`. A merged shell
 * carries `agent_status: "unknown"`; its real state comes from the foreground process (see the session's shell path).
 */
export async function listPaneTargets(request: HerdrRequestFn, opts: ListPaneTargetsOptions = {}): Promise<AgentInfo[]> {
  const agents = AgentListResultSchema.parse(await request("agent.list", {}, { signal: opts.signal })).agents;
  if (!opts.includeShells) return agents;
  const panes = PaneListResultSchema.parse(await request("pane.list", {}, { signal: opts.signal })).panes;
  const listed = new Set(agents.map((agent) => agent.terminal_id));
  const shells = panes.filter((pane) => !pane.agent && !listed.has(pane.terminal_id)).map((pane) => AgentInfoSchema.parse({
    terminal_id: pane.terminal_id,
    name: null,
    agent: null,
    title: pane.title ?? pane.label ?? null,
    terminal_title: pane.terminal_title ?? null,
    terminal_title_stripped: pane.terminal_title_stripped ?? null,
    display_agent: SHELL_LABEL,
    agent_status: "unknown",
    screen_detection_skipped: true,
    workspace_id: pane.workspace_id,
    tab_id: pane.tab_id,
    pane_id: pane.pane_id,
    focused: pane.focused,
    cwd: pane.cwd ?? null,
    foreground_cwd: pane.foreground_cwd ?? null,
    revision: pane.revision,
  }));
  return [...agents, ...shells];
}
