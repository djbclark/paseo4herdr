import type { PluginClientContext } from "@getpaseo/plugin/client";
import { errorMessage, HERDR_SHELL_PROVIDER, needsHomeExpansion, validateFolder } from "./helpers.js";
import { HERDR_BIND_OPTION, NATIVE_DEFAULT_MODEL } from "../shared/model.js";
import type { OverviewAgent } from "../shared/rpc.js";

type Paseo = PluginClientContext["paseo"];
type Ready = (input: { terminalId: string }) => Promise<unknown>;

/** A pane the screen can bind a chat to. `plain` is a pane with no detected agent (a shell): it binds as shell input. */
export type BindTarget = Pick<OverviewAgent, "terminalId" | "paneId" | "provider" | "cwd"> & { plain?: boolean };

/** A new pane Herdr just opened (a plain shell), as `herdr.pane.create` and `herdr.workspace.create` report it. */
export interface NewPane {
  terminalId: string;
  paneId: string;
  cwd: string | null;
  /** The plugin setting that lets a chat type into a plain shell is on. */
  shellInput: boolean;
}

/** `agentId` is the chat to open; null with a `note` when the pane was opened but no chat could be bound to it. */
export type NewAgentResult = { agentId: string; note: null } | { agentId: null; note: string };

/**
 * One-tap "open chat" for a running pane: create a chat in its folder's workspace that binds the existing pane (no process
 * is launched), then tell the server Paseo is listening so the earlier conversation arrives (IMPLEMENTATION.md C27). A
 * failed `ready` call is harmless: the server re-sends after a fallback delay. A pane with no agent binds as shell input,
 * which the server refuses unless the plugin setting allows it.
 */
export async function bindHerdrChat(paseo: Paseo, ready: Ready, agent: BindTarget, title: string): Promise<string> {
  if (!agent.provider || !agent.cwd) throw new Error("This agent can't be opened in Paseo");
  const workspace = await paseo.workspaces.open(agent.cwd);
  const chat = await workspace.agents.create({
    title,
    config: {
      provider: `${agent.provider}/${NATIVE_DEFAULT_MODEL}`,
      options: { [HERDR_BIND_OPTION]: { terminalId: agent.terminalId, paneId: agent.paneId, ...(agent.plain ? { allowShell: true } : {}) } },
    },
  });
  await ready({ terminalId: agent.terminalId }).catch(() => undefined);
  return chat.id;
}

/**
 * "New agent" for a pane Herdr just opened: bind a chat to it. Never starts a process: the pane stays an empty shell. Without
 * the shell setting a chat can't type into it, so the pane is left for the user to start an agent in, and `note` says so.
 */
export async function bindNewPane(paseo: Paseo, ready: Ready, pane: NewPane, fallbackCwd: string | null, title: string): Promise<NewAgentResult> {
  const cwd = pane.cwd ?? fallbackCwd;
  if (!pane.shellInput || !cwd) {
    return {
      agentId: null,
      note: `Opened a new terminal in ${title}. Start an agent in it and it will appear here. A chat can type into a plain shell only when "Allow shell input" is on in the Herdr plugin settings.`,
    };
  }
  try {
    const agentId = await bindHerdrChat(paseo, ready, { terminalId: pane.terminalId, paneId: pane.paneId, provider: HERDR_SHELL_PROVIDER, cwd, plain: true }, title);
    return { agentId, note: null };
  } catch (error) {
    throw new Error(`Opened a new terminal in ${title}, but couldn't attach a chat to it: ${errorMessage(error)}`);
  }
}

/**
 * "New agent" for a folder: open a new Herdr workspace there (`createWorkspace`) and bind a chat to its first pane.
 * Same limits as {@link bindNewPane}.
 */
export async function createHerdrChat(
  paseo: Paseo,
  ready: Ready,
  folder: string,
  createWorkspace: (cwd: string) => Promise<NewPane & { label: string }>,
  /** Asks the daemon for the absolute form of a `~` path (the client can't know the daemon's home). */
  resolve?: (folder: string) => Promise<string | null>,
): Promise<NewAgentResult> {
  const invalid = validateFolder(folder);
  if (invalid) throw new Error(invalid);
  let cwd = folder.trim();
  if (needsHomeExpansion(cwd)) {
    const resolved = resolve ? await resolve(cwd) : null;
    if (!resolved) throw new Error("Enter an absolute folder path");
    cwd = resolved;
  }
  const pane = await createWorkspace(cwd);
  return bindNewPane(paseo, ready, pane, cwd, pane.label);
}
