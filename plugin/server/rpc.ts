import { access, constants, stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";

// Derived from the SDK: Paseo's compiler can't resolve @getpaseo/client in an install without node_modules.
type PaseoApi = PluginHandlerContext["paseo"];
import { herdrPaneCreateRpc, herdrAgentRestartRpc, herdrChatAllowShellRpc, herdrChatShellAcknowledgeRpc, herdrChatReadyRpc, herdrDiagnosticsRpc, herdrDuplicatesArchiveRpc, herdrFoldersSuggestRpc, herdrOverviewRpc, herdrTargetRpc, herdrWorkspaceCreateRpc, type CompanionStatus, type HerdrTarget, type FolderSuggestion, type OverviewAgent, type OverviewTab, type OverviewWorkspace } from "../shared/rpc.js";
import { parseBinding, sameRef, sessionRefOf, type Binding } from "./binding.js";
import { expandHome, suggestFolders } from "./folders.js";
import { restartAgent } from "./restart.js";
import { buildDiagnostics, type DiagnosticsInput } from "./diagnostics.js";
import { PLUGIN_VERSION } from "./plugin-version.js";
import type { BoundSessions, OpenSessions } from "./bound-sessions.js";
import { attachArgs, attachCommand, terminalAttachArgs, terminalAttachCommand } from "./herdr-commands.js";
import { resolveSocketPath } from "./herdr/socket-path.js";
import { HerdrClient } from "./herdr/client.js";
import { listPaneTargets } from "./herdr/targets.js";
import { type AgentInfo, type PaneProcessInfo, PaneProcessInfoResultSchema, PaneListResultSchema, TabListResultSchema, TabCreatedResultSchema, WorkspaceCreatedResultSchema, WorkspaceListResultSchema } from "./herdr/schema.js";
import type { ReadyTarget } from "./herdr/target.js";
import type { HarnessAdapter } from "./harness/types.js";
import { adapterAcceptsKind, createResolver, type AdapterResolver } from "./harness/resolve.js";
import { ompSessionsDir } from "./harness/omp/companion-install.js";
import { StateStamper, TranscriptSummaryCache, EMPTY_SUMMARY, cacheInfo, laterIso, pickLastActivity, type TranscriptSummary } from "./activity.js";

export interface ManagementDeps {
  /**
   * `enabled` gates an adapter's overview presence (defaults to true; `enableOmp` keeps gating
   * only `omp` until per-adapter settings exist). `ompEnabled` still feeds the client toggle.
   */
  readTarget(): Promise<{ target: HerdrTarget; ompEnabled: boolean; enabled?(adapterId: string): boolean }>;
  ensureReady(target: HerdrTarget): Promise<ReadyTarget>;
  /** Defaults to a fresh `HerdrClient(socketPath).request(...)`. */
  request?(socketPath: string, method: string, params?: object): Promise<unknown>;
  harnesses: readonly HarnessAdapter[];
  /** Adapter routing for new work (overview rows without a chat, restart); defaults to a resolver over `harnesses`. */
  resolver?: AdapterResolver;
  /** Tests: replaces the stat/realpath check; resolves the canonical directory or throws a user-facing Error. */
  checkDirectory?(path: string): Promise<string>;
  /** Tests: the daemon user's home directory for `~` expansion; defaults to `os.homedir()`. */
  homedir?(): string;
  /** Absolute path of the `herdr` CLI, or null. Defaults to a PATH lookup. */
  findHerdr?(): Promise<string | null>;
  /** Tests: replaces the in-place restart. */
  restart?: typeof restartAgent;
  /** Bound chats awaiting `herdr.chat.ready`. */
  boundSessions?: BoundSessions;
  /** The plugin's `allowShell` gate: its enable epoch while the setting is on, else null. Shell input can only be turned on while it is open. Absent = closed. */
  shellEpoch?: () => Promise<number | null>;
  /** Open conversations by Paseo agent id (`herdr.chat.allow-shell`). */
  openSessions?: OpenSessions;
  /** Environment the CLI would resolve its socket with; defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Reads the OMP input companion's install state. Required so tests inject a fake and never read the real home. */
  companionStatus(): Promise<{ state: "current" | "outdated" | "missing" | "foreign"; path: string }>;
  /**
   * How often a server-side loop samples Herdr to stamp status changes (ms). Absent = no loop, so no agent has a
   * state-change time. The loop starts with the first overview call and never starts Herdr.
   */
  statePollMs?: number;
  /**
   * Directories a harness's session files may be read from (the overview reads a session file's times and model). Default:
   * OMP's `<agent dir>/sessions` for the `omp` adapter and nothing for any other adapter, so a path another pane reports
   * is never read.
   */
  sessionRoots?(adapterId: string): string[];
  /** Tests: a transcript summary cache to inspect; defaults to a fresh one. */
  transcripts?: TranscriptSummaryCache;
  /** Tests: the clock, in ms. */
  now?: () => number;
}

/** First executable `herdr` on PATH. Paseo terminals run commands without a shell, so pass an absolute path. */
export async function findOnPath(name: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<string | null> {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return null;
}

/** Longest the overview waits for one agent's session-file facts; past it the row simply has none (the read carries on in the background). */
export const FACTS_DEADLINE_MS = 1500;

/** `promise`'s value, or null when it hasn't settled within `ms`: a hung mount can't stall the overview. */
export async function withDeadline<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function checkDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Enter an absolute folder path");
  let real: string;
  try {
    real = await realpath(path);
    if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`${path} is not an existing folder`);
  }
  return real;
}

/** Decode the `{version, data}` plugin persistence from a Paseo agent's persistence handle, or null. */
export function decodePluginPersistence(handle: { sessionId: string; metadata?: Record<string, unknown> } | null | undefined): { version: number; data: unknown } | null {
  if (!handle) return null;
  try {
    const raw = handle.metadata?.pluginProviderPersistence ?? (handle.sessionId.startsWith("plugin:") ? JSON.parse(handle.sessionId.slice(7)) : null);
    if (typeof raw !== "object" || raw === null || typeof (raw as { version?: unknown }).version !== "number" || !("data" in raw)) return null;
    return raw as { version: number; data: unknown };
  } catch {
    return null;
  }
}

/** A Paseo chat owned by a herdr-* provider, with the Herdr binding decoded from its persistence. */
export interface HerdrChat {
  agentId: string;
  herdrSession: string | null;
  terminalId: string;
  harness: string;
  harnessId: string;
  sessionRef: Binding["sessionRef"];
  title: string | null;
  cwd: string;
  /** Latest user message or chat update; the newest chat wins when several are bound to one agent. */
  lastActivityAt: string;
  /** The foreground process the chat was bound to, when the session had validated one (pane-mode liveness). */
  occupant?: { pid: number; tty: string | null };
}

/** Every unarchived Paseo chat owned by one of the registered harness providers. */
export async function herdrChats(paseo: PaseoApi, harnesses: readonly HarnessAdapter[]): Promise<HerdrChat[]> {
  // Keyed by agent id: a list whose order shifts between pages can return one chat twice; the newest copy wins.
  const chats = new Map<string, HerdrChat>();
  const byProvider = new Map(harnesses.map((adapter) => [`herdr-${adapter.id}`, adapter]));
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await paseo.agents.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const { agent } of result.entries) {
      const adapter = byProvider.get(agent.provider);
      const persistence = adapter && !agent.archivedAt ? decodePluginPersistence(agent.persistence) : null;
      if (!adapter || !persistence) continue;
      try {
        const binding = parseBinding({ version: persistence.version, data: persistence.data as never }, adapter);
        const chat: HerdrChat = {
          agentId: agent.id, herdrSession: binding.herdrSession, terminalId: binding.terminalId, harness: adapter.label,
          harnessId: adapter.id, sessionRef: binding.sessionRef,
          title: agent.title ?? null, cwd: agent.cwd,
          lastActivityAt: activityTime(agent.lastUserMessageAt, agent.updatedAt),
          ...(binding.occupant ? { occupant: { pid: binding.occupant.pid, tty: binding.occupant.tty } } : {}),
        };
        const seen = chats.get(chat.agentId);
        if (!seen || timestamp(chat.lastActivityAt) > timestamp(seen.lastActivityAt)) chats.set(chat.agentId, chat);
      } catch {
        // Foreign or corrupt persistence: ignore.
      }
    }
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
    cursor = result.pageInfo.nextCursor;
  }
  return [...chats.values()];
}

const chatKey = (herdrSession: string | null, terminalId: string) => `${herdrSession ?? ""}\0${terminalId}`;
const timestamp = (iso: string) => Date.parse(iso) || 0;
const newestFirst = (a: HerdrChat, b: HerdrChat) => timestamp(b.lastActivityAt) - timestamp(a.lastActivityAt) || a.agentId.localeCompare(b.agentId);

/** Activity includes a reply arriving after the user's last message. */
function activityTime(userMessageAt: string | null | undefined, updatedAt: string): string {
  return userMessageAt && timestamp(userMessageAt) > timestamp(updatedAt) ? userMessageAt : updatedAt;
}

/** The foreground process of terminals hosting a pane-mode chat that bound a process; `null` when Herdr could not say. */
type PaneProcesses = ReadonlyMap<string, PaneProcessInfo | null>;

/**
 * Pane-mode bindings carry no native session ref, so the persisted occupant is the only evidence that the
 * agent in the terminal is still the one the chat was bound to. Reads one `pane.process_info` per such
 * terminal; a terminal nobody bound a process to costs nothing.
 */
async function paneProcesses(
  chats: readonly HerdrChat[],
  agents: ReadonlyMap<string, AgentInfo>,
  target: HerdrTarget,
  resolver: AdapterResolver,
  read: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<PaneProcesses> {
  const panes = new Map<string, AgentInfo>();
  for (const chat of chats) {
    const agent = agents.get(chat.terminalId);
    if (chat.herdrSession === target.herdrSession && agent && chat.occupant && resolver.byId(chat.harnessId)?.binding === "pane") panes.set(chat.terminalId, agent);
  }
  return new Map(await Promise.all([...panes].map(async ([terminalId, agent]): Promise<[string, PaneProcessInfo | null]> => {
    try {
      const { process_info: info } = PaneProcessInfoResultSchema.parse(await read("pane.process_info", { pane_id: agent.pane_id }));
      // An alias answer (Herdr resolved a moved pane id) is not evidence about this terminal.
      return [terminalId, info.pane_id === agent.pane_id ? info : null];
    } catch {
      return [terminalId, null];
    }
  })));
}

/** The same replacement test the session applies on validation: not the harness, another pid, or another tty. */
function occupantReplaced(adapter: HarnessAdapter, occupant: NonNullable<HerdrChat["occupant"]>, info: PaneProcessInfo): boolean {
  const pid = info.foreground_process_group_id;
  return !pid || !adapter.isOccupant(info) || pid !== occupant.pid || (info.tty ?? null) !== occupant.tty;
}

/** A terminal can host a new native conversation after /new; keep its older chats separate. */
function liveChat(chat: HerdrChat, agents: ReadonlyMap<string, AgentInfo>, target: HerdrTarget, resolver: AdapterResolver, processes?: PaneProcesses): AgentInfo | undefined {
  if (chat.herdrSession !== target.herdrSession) return undefined;
  const agent = agents.get(chat.terminalId);
  if (!agent) return undefined;
  // An existing binding keeps its adapter even after the pane is later detected as another
  // kind; a pane-mode binding additionally does not pin a native session ref.
  const adapter = resolver.byId(chat.harnessId);
  if (!adapter || !adapterAcceptsKind(adapter, agent.agent)) return undefined;
  if (adapter.binding === "native-ref" && !sameRef(chat.sessionRef, sessionRefOf(agent))) return undefined;
  // A pane-mode chat whose agent was replaced in the terminal is frozen history, not the pane's live chat.
  // An unreadable pane (no entry, or null) keeps the chat live rather than guessing.
  const info = adapter.binding === "pane" && chat.occupant ? processes?.get(chat.terminalId) : null;
  if (info && chat.occupant && occupantReplaced(adapter, chat.occupant, info)) return undefined;
  return agent;
}

/** One terminal's live chats: the newest owns the row, the others are duplicates the client may archive. */
export interface ReconciledTerminal {
  owner: HerdrChat;
  duplicates: HerdrChat[];
}

/**
 * F4: reconcile the chats bound to each live Herdr agent. The owner is the newest live chat
 * (deterministic; ties by agent id); the other live chats on the same terminal are reported as
 * `duplicates` so the client can archive them — the server never archives from a read RPC.
 * Chats that are no longer live (an older native conversation after /new) stay separate.
 */
export function reconcileChats(
  chats: HerdrChat[],
  live: ReadonlyMap<string, AgentInfo>,
  target: HerdrTarget,
  resolver: AdapterResolver,
  processes?: PaneProcesses,
): Map<string, ReconciledTerminal> {
  const out = new Map<string, ReconciledTerminal>();
  for (const chat of chats.filter((chat) => liveChat(chat, live, target, resolver, processes)).sort(newestFirst)) {
    const key = chatKey(chat.herdrSession, chat.terminalId);
    const entry = out.get(key);
    if (entry) entry.duplicates.push(chat);
    else out.set(key, { owner: chat, duplicates: [] });
  }
  return out;
}

/**
 * The adapter a Herdr pane's overview row belongs to: the terminal's owner chat keeps the
 * adapter it was bound with (a saved fallback chat survives the pane being detected as a
 * specific kind); a chat-less pane routes to the adapter for new work.
 */
function ownerAdapter(
  reconciled: Map<string, ReconciledTerminal>,
  agent: AgentInfo,
  target: HerdrTarget,
  resolver: AdapterResolver,
): HarnessAdapter | undefined {
  const owner = reconciled.get(chatKey(target.herdrSession, agent.terminal_id))?.owner;
  return ((owner && resolver.byId(owner.harnessId)) ?? resolver.select(agent.agent)) ?? undefined;
}

export function registerManagementRpcs(server: Pick<PluginServerContext, "handle">, deps: ManagementDeps): () => void {
  const request = deps.request ?? ((socketPath, method, params) => new HerdrClient(socketPath).request(method, params));
  const check = deps.checkDirectory ?? checkDirectory;
  const home = () => (deps.homedir ?? homedir)();
  const resolver = deps.resolver ?? createResolver(deps.harnesses);
  const targets = (socketPath: string) => (method: string, params?: Record<string, unknown>) => request(socketPath, method, params);
  const now = deps.now ?? Date.now;
  const transcripts = deps.transcripts ?? new TranscriptSummaryCache();
  const stamper = new StateStamper();
  const sessionRoots = deps.sessionRoots ?? ((adapterId: string) => (adapterId === "omp" ? [ompSessionsDir(deps.env ?? process.env, home())] : []));

  /** One sample of Herdr's agent list for the state-change stamps. Never starts Herdr; a failed sample changes nothing. */
  const sampleStates = async (): Promise<void> => {
    try {
      const { target } = await deps.readTarget();
      await deps.ensureReady({ ...target, autoStart: false, autoStartDisabledReason: "This check never starts Herdr" });
      const agents = await listPaneTargets(targets(target.socketPath));
      const at = now();
      for (const agent of agents) stamper.observe(chatKey(target.herdrSession, agent.terminal_id), agent.agent_status, agent.state_change_seq, at);
      stamper.retain(new Set(agents.map((agent) => chatKey(target.herdrSession, agent.terminal_id))));
    } catch {
      // Herdr is down or busy: keep the stamps; a restart shows up as a changed or reset sequence on the next good sample.
    }
  };
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let sampling = false;
  const sampleOnce = async (): Promise<void> => {
    if (sampling) return;
    sampling = true;
    try { await sampleStates(); } finally { sampling = false; }
  };
  /** Starts the loop on first use and waits for its first sample, so the first overview already has first-sight stamps. */
  const ensureStatePoll = async (): Promise<void> => {
    if (!deps.statePollMs || pollTimer || stopped) return;
    pollTimer = setInterval(() => { void sampleOnce(); }, deps.statePollMs);
    pollTimer.unref?.();
    await sampleOnce();
  };

  interface AgentFacts {
    summary: TranscriptSummary;
    lastActivity: ReturnType<typeof pickLastActivity>;
  }
  /** Session-file facts for one agent; a missing or unreadable file is just "no facts". */
  const readFacts = async (agent: AgentInfo, chatAt: string | null, roots: readonly string[]): Promise<AgentFacts> => {
    const session = agent.agent_session;
    // The path was reported by whatever runs in the pane: only the owning harness's own session directory is read.
    const read = session?.kind === "path" && roots.length > 0 ? await withDeadline(transcripts.readWithin(session.value, roots, FACTS_DEADLINE_MS).catch(() => null), FACTS_DEADLINE_MS + 500) : null;
    const summary = read?.summary ?? EMPTY_SUMMARY;
    const transcriptAt = laterIso(summary.lastAssistantAt, summary.lastUserAt);
    return { summary, lastActivity: pickLastActivity({ transcriptAt, fileMtime: read?.mtime ?? null, chatAt }) };
  };

  /** Folders Herdr's workspaces and agents are in on the configured target; empty when Herdr is unavailable. */
  const herdrFolders = async (): Promise<string[]> => {
    try {
      const { target } = await deps.readTarget();
      const [agents, panes] = await Promise.all([
        listPaneTargets(targets(target.socketPath)).then((listed) => listed.map((a) => a.cwd ?? a.foreground_cwd)),
        request(target.socketPath, "pane.list", {}).then((r) => PaneListResultSchema.parse(r).panes.map((p) => p.cwd ?? p.foreground_cwd)),
      ]);
      return [...agents, ...panes].filter((cwd): cwd is string => typeof cwd === "string" && isAbsolute(cwd));
    } catch {
      return [];
    }
  };
  /** Directories of Paseo's own workspaces, when the handler context exposes the Paseo API. */
  const paseoFolders = async (paseo: PaseoApi | undefined): Promise<string[]> => {
    try {
      const result = await paseo?.workspaces?.list({ page: { limit: 100 } });
      return (result?.entries ?? []).map((w) => w.workspaceDirectory ?? w.projectRootPath).filter((dir): dir is string => Boolean(dir) && isAbsolute(dir));
    } catch {
      return [];
    }
  };

  /** Read-only detection: does each harness process have its input endpoint? (one process_info per agent) */
  const readInputReady = async (
    socket: string,
    agents: readonly AgentInfo[],
    reconciled: Map<string, ReconciledTerminal>,
    target: HerdrTarget,
    enabled: (adapterId: string) => boolean,
  ): Promise<Map<string, boolean | null>> =>
    new Map(await Promise.all(agents.map(async (agent): Promise<[string, boolean | null]> => {
      const adapter = ownerAdapter(reconciled, agent, target, resolver);
      if (!agent.agent || !adapter?.inputReachable || !enabled(adapter.id)) return [agent.terminal_id, null];
      try {
        const process = PaneProcessInfoResultSchema.parse(await request(socket, "pane.process_info", { pane_id: agent.pane_id })).process_info;
        const pid = process.foreground_process_group_id;
        return [agent.terminal_id, pid && adapter.isOccupant(process) ? await adapter.inputReachable(pid) : null];
      } catch {
        return [agent.terminal_id, null];
      }
    })));

  /**
   * The foreground program of each pane with no agent (one `pane.process_info` each, bounded). A pane Herdr can't read, or one
   * that answers too slowly, has no entry: the row then says "Terminal" instead of a program name.
   */
  const readPrograms = async (socket: string, plain: readonly AgentInfo[]): Promise<Map<string, { name: string; isShell: boolean }>> => {
    const isShell = deps.harnesses.find((adapter) => adapter.shell)?.shell?.isShell;
    const entries = await Promise.all(plain.map(async (agent): Promise<[string, { name: string; isShell: boolean }] | null> => {
      const info = await withDeadline(
        request(socket, "pane.process_info", { pane_id: agent.pane_id }).then((reply) => PaneProcessInfoResultSchema.parse(reply).process_info, () => null),
        FACTS_DEADLINE_MS,
      );
      if (!info) return null;
      const leader = info.foreground_processes.find((candidate) => candidate.pid === info.foreground_process_group_id) ?? info.foreground_processes[0];
      const name = leader?.name?.replace(/^-/, "").trim();
      return name ? [agent.terminal_id, { name: name.slice(0, 80), isShell: Boolean(isShell?.({ name: leader!.name })) }] : null;
    }));
    return new Map(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
  };

  /** Whether a chat may type into a plain shell right now; an unreadable setting counts as closed. */
  const shellGateOpen = async (): Promise<boolean> => {
    try { return ((await deps.shellEpoch?.()) ?? null) !== null; } catch { return false; }
  };

  /** A failing check is reported as `unknown` rather than failing the overview. */
  const readCompanion = (): Promise<CompanionStatus> =>
    deps.companionStatus().then((status): CompanionStatus => ({ state: status.state, path: status.path }), (): CompanionStatus => ({ state: "unknown" }));

  server.handle(herdrTargetRpc, async () => {
    const { target, ompEnabled } = await deps.readTarget();
    return { target, ompEnabled };
  });

  server.handle(herdrFoldersSuggestRpc, async ({ query }, { paseo }) => {
    const [fromHerdr, fromPaseo] = await Promise.all([herdrFolders(), paseoFolders(paseo)]);
    const known: FolderSuggestion[] = [
      ...fromHerdr.map((path) => ({ path, source: "herdr" as const })),
      ...fromPaseo.map((path) => ({ path, source: "paseo" as const })),
    ];
    return suggestFolders(query, home(), known);
  });

  server.handle(herdrOverviewRpc, async ({ noAutoStart }, { paseo }) => {
    const { target, ompEnabled, enabled: enabledFor } = await deps.readTarget();
    if (!noAutoStart) await ensureStatePoll();
    const enabled = (adapterId: string) => enabledFor?.(adapterId) ?? true;
    const [chatResult, readyResult] = await Promise.allSettled([
      herdrChats(paseo, deps.harnesses),
      deps.ensureReady(noAutoStart ? { ...target, autoStart: false, autoStartDisabledReason: "This check never starts Herdr" } : target),
    ]);
    const chats = chatResult.status === "fulfilled" ? chatResult.value : [];
    const chatError = chatResult.status === "rejected" ? errorMessage(chatResult.reason) : null;
    const companion = await readCompanion();
    const unavailable = (error: unknown) => ({
      target, ompEnabled, connection: { status: "unavailable" as const, error: errorMessage(error) },
      companion, workspaces: [], chatError, shellInput: false,
    });
    if (readyResult.status === "rejected") return unavailable(readyResult.reason);
    const ready = readyResult.value;
    try {
      const socket = target.socketPath;
      // `herdr --session <name>` must reach this same socket, or the terminal would attach elsewhere.
      const herdrPath = resolveSocketPath({ session: target.herdrSession ?? undefined, env: { ...(deps.env ?? process.env), HERDR_SOCKET_PATH: undefined, HERDR_SESSION: undefined } }) === socket
        ? await (deps.findHerdr ?? (() => findOnPath("herdr", deps.env)))()
        : null;
      const [workspaces, tabs, panes, agents] = await Promise.all([
        request(socket, "workspace.list", {}).then((r) => WorkspaceListResultSchema.parse(r).workspaces),
        request(socket, "tab.list", {}).then((r) => TabListResultSchema.parse(r).tabs),
        request(socket, "pane.list", {}).then((r) => PaneListResultSchema.parse(r).panes),
        // Plain shells and other programs are listed too (`agent: null`); they carry no agent facts.
        listPaneTargets(targets(socket), { includeShells: true }),
      ]);
      const isPlain = (agent: AgentInfo) => !agent.agent;
      const programs = await readPrograms(socket, agents.filter(isPlain));
      const shellInput = await shellGateOpen();
      const live = new Map(agents.map((agent) => [agent.terminal_id, agent]));
      const reconciled = reconcileChats(chats, live, target, resolver, await paneProcesses(chats, live, target, resolver, (method, params) => request(socket, method, params)));
      const inputReady = await readInputReady(socket, agents, reconciled, target, enabled);
      const facts = new Map(await Promise.all(agents.map(async (agent): Promise<[string, AgentFacts]> => {
        const owner = ownerAdapter(reconciled, agent, target, resolver);
        // A pane with no agent has no session file: nothing is read for it.
        const roots = owner && enabled(owner.id) && !isPlain(agent) ? sessionRoots(owner.id) : [];
        return [agent.terminal_id, await readFacts(agent, reconciled.get(chatKey(target.herdrSession, agent.terminal_id))?.owner.lastActivityAt ?? null, roots)];
      })));
      // Keep each stamp current with what Herdr says now (idempotent with the loop), so a change never leaves a gap before the next sample.
      if (deps.statePollMs) {
        const seen = now();
        for (const agent of agents) if (!isPlain(agent)) stamper.observe(chatKey(target.herdrSession, agent.terminal_id), agent.agent_status, agent.state_change_seq, seen);
      }
      const paneLabel = new Map(panes.map((pane) => [pane.pane_id, pane.label?.trim() || null]));
      // Pane numbers: Herdr's own when it sends one, else the 1-based position among the tab's panes in list order.
      const paneNumber = new Map<string, number>();
      const perTab = new Map<string, number>();
      for (const pane of panes) {
        const position = (perTab.get(pane.tab_id) ?? 0) + 1;
        perTab.set(pane.tab_id, position);
        paneNumber.set(pane.pane_id, pane.number ?? position);
      }
      const tabNumber = new Map(tabs.map((tab) => [tab.tab_id, tab.number]));
      const out: OverviewWorkspace[] = [...workspaces].sort((a, b) => a.number - b.number).map((workspace) => {
        const firstPane = panes
          .filter((pane) => pane.workspace_id === workspace.workspace_id)
          .sort((a, b) => (tabNumber.get(a.tab_id) ?? 0) - (tabNumber.get(b.tab_id) ?? 0))[0];
        const overviewTabs: OverviewTab[] = tabs
          .filter((tab) => tab.workspace_id === workspace.workspace_id)
          .sort((a, b) => a.number - b.number)
          .map((tab) => ({
            tabId: tab.tab_id,
            number: tab.number,
            label: tab.label,
            focused: tab.focused,
            status: tab.agent_status,
            agents: agents.filter((agent) => agent.tab_id === tab.tab_id).map((agent): OverviewAgent => {
              // A disabled adapter is hidden (no provider link, no restart); its bound chats stay openable.
              const resolved = ownerAdapter(reconciled, agent, target, resolver);
              const adapter = resolved && enabled(resolved.id) ? resolved : undefined;
              const plain = isPlain(agent);
              const program = plain ? programs.get(agent.terminal_id) ?? null : null;
              const bound = reconciled.get(chatKey(target.herdrSession, agent.terminal_id));
              const fact = facts.get(agent.terminal_id)!;
              // A stamp counts only while it still matches the status and sequence Herdr reports now.
              const stamp = stamper.get(chatKey(target.herdrSession, agent.terminal_id));
              const stampCurrent = stamp !== null && stamp.status === agent.agent_status && stamp.seq === agent.state_change_seq;
              const model = fact.summary.model;
              return {
                terminalId: agent.terminal_id,
                paneId: agent.pane_id,
                name: agent.name ?? null,
                title: agent.terminal_title_stripped ?? agent.title ?? agent.terminal_title ?? null,
                kind: agent.agent ?? null,
                // A plain pane has no harness; its provider is the shell-capable one, used only to chat with it as a shell.
                harness: plain ? null : adapter?.label ?? null,
                provider: adapter && (!plain || adapter.shell) ? `herdr-${adapter.id}` : null,
                status: plain ? "unknown" : agent.agent_status,
                cwd: agent.cwd ?? agent.foreground_cwd ?? null,
                paseoAgentId: bound?.owner.agentId ?? null,
                duplicateChatIds: bound?.duplicates.map((chat) => chat.agentId) ?? [],
                // `herdr agent attach` resolves names and pane ids, not terminal ids; a pane with no agent is attached by terminal id.
                attachCommand: plain
                  ? terminalAttachCommand(target.herdrSession, agent.terminal_id)
                  : attachCommand(target.herdrSession, agent.name ?? agent.pane_id),
                attach: herdrPath
                  ? { command: herdrPath, args: plain ? terminalAttachArgs(target.herdrSession, agent.terminal_id) : attachArgs(target.herdrSession, agent.name ?? agent.pane_id) }
                  : null,
                inputReady: inputReady.get(agent.terminal_id) ?? null,
                canRestart: !plain && Boolean(adapter?.launch && adapter.resumeArgs && agent.agent_session),
                paneNumber: paneNumber.get(agent.pane_id) ?? null,
                paneLabel: paneLabel.get(agent.pane_id) ?? null,
                plain,
                program: program?.name ?? null,
                isShell: program?.isShell ?? false,
                lastActivityAt: fact.lastActivity?.at ?? null,
                lastActivitySource: fact.lastActivity?.source ?? null,
                stateChangedAt: stampCurrent ? stamp.at : null,
                stateChangedExact: stampCurrent ? stamp.exact : false,
                stateChangeSeq: agent.state_change_seq,
                sessionStartedAt: fact.summary.sessionStartedAt,
                lastAssistantAt: fact.summary.lastAssistantAt,
                model,
                cache: cacheInfo(model, fact.summary),
              };
            }),
          }));
        return {
          workspaceId: workspace.workspace_id,
          number: workspace.number,
          label: workspace.label,
          focused: workspace.focused,
          cwd: firstPane?.cwd ?? firstPane?.foreground_cwd ?? null,
          status: workspace.agent_status,
          tabs: overviewTabs,
        };
      });
      return { target, ompEnabled, connection: { status: "connected" as const, version: ready.version, autoStarted: ready.autoStarted }, companion, shellInput, workspaces: out, chatError, serverNow: new Date(now()).toISOString(), ...(deps.statePollMs ? { statePollMs: deps.statePollMs } : {}) };
    } catch (error) {
      return unavailable(error);
    }
  });

  server.handle(herdrDiagnosticsRpc, async (_input, { paseo }) => {
    const { target, ompEnabled, enabled: enabledFor } = await deps.readTarget();
    const enabled = (adapterId: string) => enabledFor?.(adapterId) ?? true;
    const companion = await readCompanion();
    let herdr: DiagnosticsInput["herdr"] = { connected: false, version: null, autoStarted: false, error: null };
    let agents: DiagnosticsInput["agents"] = [];
    try {
      const ready = await deps.ensureReady(target);
      herdr = { connected: true, version: ready.version, autoStarted: ready.autoStarted, error: null };
      const socket = target.socketPath;
      const listed = await listPaneTargets(targets(socket));
      const chats = await herdrChats(paseo, deps.harnesses).catch((): HerdrChat[] => []);
      const live = new Map(listed.map((agent): [string, AgentInfo] => [agent.terminal_id, agent]));
      const reconciled = reconcileChats(chats, live, target, resolver, await paneProcesses(chats, live, target, resolver, (method, params) => request(socket, method, params)));
      const inputReady = await readInputReady(socket, listed, reconciled, target, enabled);
      agents = listed.map((agent) => ({ paneId: agent.pane_id, inputReady: inputReady.get(agent.terminal_id) ?? null }));
    } catch (error) {
      herdr = { ...herdr, error: errorMessage(error) };
    }
    return buildDiagnostics({ pluginVersion: PLUGIN_VERSION, target, ompEnabled, herdr, companion, agents });
  });

  server.handle(herdrDuplicatesArchiveRpc, async ({ terminalId, paneId, ownerId, ids }, { paseo }) => {
    const { target } = await deps.readTarget();
    // A button tap must not spawn Herdr: an unreachable Herdr fails the call with its real reason.
    await deps.ensureReady({ ...target, autoStart: false, autoStartDisabledReason: "This check never starts Herdr" });
    const socket = target.socketPath;
    const agents = await listPaneTargets(targets(socket));
    let chats: HerdrChat[];
    try { chats = await herdrChats(paseo, deps.harnesses); }
    catch (error) { throw new Error(`Paseo's chat list is unavailable (${errorMessage(error)}), so the chats can't be checked.`); }
    const live = new Map(agents.map((candidate): [string, AgentInfo] => [candidate.terminal_id, candidate]));
    const reconciled = reconcileChats(chats, live, target, resolver, await paneProcesses(chats, live, target, resolver, (method, params) => request(socket, method, params)));
    if (live.get(terminalId)?.pane_id !== paneId) return { skip: "agent-gone" as const, archived: [], failures: [] };
    const bound = reconciled.get(chatKey(target.herdrSession, terminalId));
    if (bound?.owner.agentId !== ownerId) return { skip: "owner-changed" as const, archived: [], failures: [] };
    const stillDuplicates = new Set(bound.duplicates.map((chat) => chat.agentId));
    // Defence in depth: the owner is never a duplicate, whatever the chat list looked like.
    const wanted = [...new Set(ids)].filter((id) => id !== ownerId && stillDuplicates.has(id));
    if (wanted.length === 0) return { skip: "none-left" as const, archived: [], failures: [] };
    // `async` turns a synchronous throw from ref()/archive() into that id's failure instead of rejecting the whole call.
    const results = await Promise.allSettled(wanted.map(async (id) => paseo.agents.ref(id).archive()));
    return {
      skip: null,
      archived: wanted.filter((_id, index) => results[index]!.status === "fulfilled"),
      failures: results.flatMap((result, index) => (result.status === "rejected" ? [{ id: wanted[index]!, error: errorMessage(result.reason) }] : [])),
    };
  });

  server.handle(herdrAgentRestartRpc, async ({ terminalId, paneId }, { paseo }) => {
    const { target, enabled: enabledFor } = await deps.readTarget();
    await deps.ensureReady(target);
    const socket = target.socketPath;
    const agents = await listPaneTargets(targets(socket));
    const agent = agents.find((candidate) => candidate.terminal_id === terminalId);
    if (!agent) throw new Error("The agent is no longer running in Herdr.");
    // Same routing as the overview row: the owner chat's adapter if one exists, else new-work routing.
    // Without the chat list the owner is unknown and `select` could pick a different adapter than the
    // overview offered, so a failed listing refuses the restart instead of guessing.
    let chats: HerdrChat[];
    try { chats = await herdrChats(paseo, deps.harnesses); }
    catch (error) { throw new Error(`Can't restart this agent: Paseo's chat list is unavailable (${errorMessage(error)}), so the adapter that owns it is unknown. Try again.`); }
    const live = new Map(agents.map((candidate): [string, AgentInfo] => [candidate.terminal_id, candidate]));
    const reconciled = reconcileChats(chats, live, target, resolver, await paneProcesses(chats, live, target, resolver, (method, params) => request(socket, method, params)));
    const adapter = ownerAdapter(reconciled, agent, target, resolver);
    if (!adapter) throw new Error("The agent is no longer running in Herdr.");
    // The overview hides a disabled adapter's restart; a stale row or a direct call must not bypass that.
    if (!(enabledFor?.(adapter.id) ?? true)) throw new Error(`${adapter.label} is turned off in the Herdr plugin settings`);
    // An open chat on this agent stays read-only; the client binds a fresh chat and archives the old one.
    return (deps.restart ?? restartAgent)({ request: (method, params) => request(socket, method, params) }, adapter, { terminalId, paneId });
  });

  server.handle(herdrChatReadyRpc, async ({ terminalId }) => {
    const { target } = await deps.readTarget();
    return { flushed: deps.boundSessions?.flushHistory(target.herdrSession, terminalId) ?? 0 };
  });

  server.handle(herdrChatAllowShellRpc, async ({ agentId, enabled }) => {
    const sessions = deps.openSessions?.byAgentId(agentId) ?? [];
    let epoch: number | null = null;
    if (enabled) {
      try { epoch = (await deps.shellEpoch?.()) ?? null; } catch (error) {
        throw new Error(`The Herdr plugin settings could not be read, so shell input was not turned on (${error instanceof Error ? error.message : String(error)}); try again.`);
      }
      if (epoch === null) throw new Error("Shell input is turned off in the Herdr plugin settings; turn on \"Allow shell input\" there first.");
    }
    if (sessions.length === 0) {
      if (enabled) throw new Error("This conversation is not open in the Herdr plugin; open it in Paseo first.");
      // Paseo owns the stored flag and the plugin cannot rewrite it, so remember the revocation; the next open of this agent id clears it.
      deps.openSessions?.revokeShell(agentId);
      // Never `applied: false` here: that reads as "nothing to stop". A conversation that is open but has no `PASEO_AGENT_ID` in its env cannot be reached by id, and keeps typing.
      throw new Error(`No open conversation in the Herdr plugin has Paseo agent id ${agentId}, so nothing was stopped now. If it is closed, it loses shell input when it is next opened; if it is open and still typing, turn off "Allow shell input" in the Herdr plugin settings.`);
    }
    if (enabled) deps.openSessions?.clearRevoked(agentId);
    let applied = false;
    for (const session of sessions) applied = session.setAllowShell(enabled, epoch ?? undefined).applied || applied;
    return { enabled, applied };
  });

  server.handle(herdrChatShellAcknowledgeRpc, async ({ agentId }) => {
    const sessions = deps.openSessions?.byAgentId(agentId) ?? [];
    if (sessions.length === 0) throw new Error("This conversation is not open in the Herdr plugin; open it in Paseo first.");
    let acknowledged = false;
    for (const session of sessions) acknowledged = session.acknowledgeShell() || acknowledged;
    return { acknowledged };
  });

  server.handle(herdrWorkspaceCreateRpc, async ({ cwd, label }) => {
    const real = await check(expandHome(cwd.trim(), home()));
    const { target } = await deps.readTarget();
    await deps.ensureReady(target);
    const name = label || basename(real) || real;
    const created = WorkspaceCreatedResultSchema.parse(await request(target.socketPath, "workspace.create", { cwd: real, label: name, focus: false }));
    return {
      workspaceId: created.workspace.workspace_id, label: name, cwd: real,
      paneId: created.root_pane.pane_id, terminalId: created.root_pane.terminal_id, shellInput: await shellGateOpen(),
    };
  });

  server.handle(herdrPaneCreateRpc, async ({ workspaceId }) => {
    const { target } = await deps.readTarget();
    await deps.ensureReady(target);
    // One new tab with one shell pane; no program is started in it. Without `cwd` Herdr roots it in the workspace.
    const created = TabCreatedResultSchema.parse(await request(target.socketPath, "tab.create", { workspace_id: workspaceId, focus: false }));
    return {
      workspaceId: created.tab.workspace_id,
      tabId: created.tab.tab_id,
      paneId: created.root_pane.pane_id,
      terminalId: created.root_pane.terminal_id,
      cwd: created.root_pane.cwd ?? created.root_pane.foreground_cwd ?? null,
      shellInput: await shellGateOpen(),
    };
  });

  /** Stops the state-change loop (plugin shutdown). */
  return () => {
    stopped = true;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  };
}
