import { COMPANION_INSTALL_NAME, COMPANION_INSTALL_STEP, LEGACY_COMPANION_NAME } from "../shared/companion.js";
import { cleanTitle } from "../shared/labels.js";
import type { CompanionStatus, Diagnostics, HerdrAgentStatus, HerdrTarget } from "../shared/rpc.js";
import type { FlatAgent } from "./sort.js";
import { agoText, cacheSpeech, spoken, stateDurationSpeech, type CacheState } from "./time.js";

/** Pure helpers for the Herdr client UI (no React, no React Native). */

/** Paseo provider id of the fallback harness, the only one that can chat with a plain shell pane (and only with shell input allowed). */
export const HERDR_SHELL_PROVIDER = "herdr-generic";
export const OVERVIEW_SCREEN_ID = "herdr-overview";

export const OVERVIEW_QUERY_KEY = ["herdr", "overview"] as const;
export const TARGET_QUERY_KEY = ["herdr", "target"] as const;
export const OVERVIEW_REFETCH_MS = 4000;

const STATUS_LABELS: Record<HerdrAgentStatus, string> = {
  idle: "Idle",
  working: "Working",
  blocked: "Blocked",
  done: "Done",
  unknown: "Unknown",
};

/**
 * The settings document after the "Allow shell input" switch moves. Every move, on or off, stores a new enable epoch (never
 * equal to the previous one, even on a repeated clock reading): conversations that opted in under an older epoch stay
 * disarmed, and so does a later write that only flips `allowShell` back to true, because it keeps the epoch the off-save stored.
 */
export function withShellSwitch<T extends { allowShell: boolean; allowShellEpoch: number }>(values: T, allowShell: boolean, now: number): T {
  return { ...values, allowShell, allowShellEpoch: Math.max(now, values.allowShellEpoch + 1) };
}

export function statusLabel(status: HerdrAgentStatus): string {
  return STATUS_LABELS[status];
}

/** Status is never colour alone: each has a glyph and a word. */
const STATUS_GLYPHS: Record<HerdrAgentStatus, string> = { working: "▶", blocked: "!", done: "✓", idle: "○", unknown: "?" };

export function statusGlyph(status: HerdrAgentStatus): string {
  return STATUS_GLYPHS[status];
}

/** The workspace as Herdr names it; its number only when it has no name. */
export function workspaceText(workspace: { number: number; label: string }): string {
  return workspace.label.trim() || `workspace ${workspace.number}`;
}

/** The tab as Herdr names it. Herdr's auto name for a tab is its number, so that case (and no name) reads `tab 1`. */
export function tabText(tab: { number: number; label: string }): string {
  const label = tab.label.trim();
  return label === "" || label === String(tab.number) ? `tab ${tab.number}` : label;
}

/**
 * The pane's own name when the Herdr user set one. Without one, a pane is told apart by its number (`pane 2`) only when its
 * tab holds more than one pane, because only then are two rows otherwise indistinguishable.
 */
export function paneText(agent: { paneLabel: string | null; paneNumber: number | null }, tabPanes: number): string {
  const label = agent.paneLabel?.trim();
  if (label) return label;
  return tabPanes > 1 && agent.paneNumber !== null ? `pane ${agent.paneNumber}` : "";
}

/** The place line: `api-server › tests › pane 2`. In a grouped card the workspace is the card header, so it drops. */
export function placeText(
  item: { workspace: { number: number; label: string }; tab: { number: number; label: string }; tabPanes: number; agent: { paneLabel: string | null; paneNumber: number | null } },
  grouped: boolean,
): string {
  return [grouped ? "" : workspaceText(item.workspace), tabText(item.tab), paneText(item.agent, item.tabPanes)].filter(Boolean).join(" › ");
}

/** What a pane with no agent is doing, in Herdr's terms: `Shell`, or the program in the foreground. */
export function plainState(agent: { isShell: boolean; program: string | null }): string {
  return agent.isShell ? "Shell" : agent.program ?? "Terminal";
}

/** "New agent in this pane" applies to a pane with no agent only when it is a real shell and shell input is allowed. */
export function plainPaneBindable(agent: { plain: boolean; isShell: boolean }, shellInput: boolean): boolean {
  return !agent.plain || (shellInput && agent.isShell);
}

/**
 * What a plain row shows next to its `$` glyph. When the pane's name is just the program (`vim`, `zsh`) the name is
 * the title and the state word is dropped, so the row reads "$ vim", not "$ vim vim" or "$ Shell zsh".
 */
export function plainRowTitle(agent: { isShell: boolean; program: string | null }, label: string): { state: string; name: string | null } {
  const state = plainState(agent);
  const same = (a: string | null) => a !== null && a.trim().toLowerCase() === label.trim().toLowerCase();
  if (same(agent.program) || same(state)) return { state: agent.program ?? state, name: null };
  return { state, name: label };
}

/** The last two segments of a path with a leading ellipsis, so a long absolute folder stays useful in a narrow line. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

/** One sentence for screen readers. Built on the coarse tick only, so it doesn't change every second. */
export function agentSpeech(item: FlatAgent, label: string, cache: CacheState, nowMs: number): string {
  const { agent } = item;
  const state = agent.plain
    ? plainState(agent).toLowerCase()
    : [statusLabel(agent.status).toLowerCase(), stateDurationSpeech(agent.stateChangedAt, agent.stateChangedExact, nowMs)].filter(Boolean).join(" ");
  const parts = [label, state];
  if (agent.harness) parts.push(agent.harness);
  const tab = tabText(item.tab);
  const pane = paneText(agent, item.tabPanes);
  parts.push(`workspace ${workspaceText(item.workspace)}`, tab.startsWith("tab ") ? tab : `tab ${tab}`);
  if (pane) parts.push(pane.startsWith("pane ") ? pane : `pane ${pane}`);
  const active = agoText(agent.lastActivityAt, nowMs, false);
  if (active && active !== "<1m") parts.push(`active ${spokenAgo(agent.lastActivityAt, nowMs)}`);
  else if (active) parts.push("active less than a minute ago");
  const cacheSentence = cacheSpeech(cache);
  if (cacheSentence) parts.push(cacheSentence);
  return parts.join(", ");
}

function spokenAgo(iso: string | null, nowMs: number): string {
  return `${spoken((nowMs - Date.parse(iso ?? "")) / 1000)} ago`;
}

export type StatusTone = "success" | "warning" | "danger" | "muted" | "accent";

export function statusTone(status: HerdrAgentStatus): StatusTone {
  switch (status) {
    case "working":
      return "accent";
    case "blocked":
      return "warning";
    case "done":
      return "success";
    case "idle":
    case "unknown":
      return "muted";
  }
}

export function describeTarget(target: HerdrTarget): string[] {
  const lines = [`Socket: ${target.socketPath}`];
  lines.push(target.herdrSession ? `Session: ${target.herdrSession}` : "Session: default");
  lines.push(target.autoStart ? "Auto-start: on" : "Auto-start: off");
  return lines;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Something went wrong";
}

/** Returns an error for an unusable folder path, else null. The server validates authoritatively (and expands a leading `~`). */
export function validateFolder(path: string): string | null {
  return path.trim() ? null : "Enter a folder path";
}

/** Short label for a path: its last segment. */
export function pathTail(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Readable agent label, the same one Paseo's Import session sheet shows (see shared/labels.ts). */
export function agentLabel(agent: { title: string | null; name: string | null; kind: string | null; terminalId: string; program?: string | null }): string {
  return cleanTitle(agent.title) ?? agent.name ?? agent.kind ?? agent.program ?? agent.terminalId;
}

/** The Herdr screen's two pickers: panes with a detected agent, and panes with none. */
export type PickerKind = "agent" | "terminal";

/** Most rows a picker lists at once; the filter narrows further. */
export const PICKER_LIMIT = 50;

/**
 * Panes for the "Open existing agent" / "Open existing terminal" pickers. The source is Herdr's own overview, so nothing that
 * isn't a Herdr pane can appear: an agent picker lists panes with a detected agent (`plain` false), a terminal picker lists
 * panes with none. `query` is a case-insensitive match against workspace, tab, pane, title, harness, program and folder names.
 * Order is Herdr's: workspace, tab, pane.
 */
export function pickerItems(items: readonly FlatAgent[], kind: PickerKind, query: string): FlatAgent[] {
  const needle = query.trim().toLowerCase();
  return items
    .filter(({ agent }) => agent.plain === (kind === "terminal"))
    .filter((item) => !needle || pickerHaystack(item).some((field) => field.toLowerCase().includes(needle)))
    .slice(0, PICKER_LIMIT);
}

function pickerHaystack(item: FlatAgent): string[] {
  const { agent } = item;
  return [
    workspaceText(item.workspace),
    tabText(item.tab),
    paneText(agent, item.tabPanes),
    agentLabel(agent),
    agent.harness ?? "",
    agent.kind ?? "",
    agent.program ?? "",
    agent.cwd ?? "",
    agent.paneId,
  ];
}

/** Text under a picker option's name: where the pane is, in Herdr's own names. */
export function pickerPlace(item: FlatAgent): string {
  return placeText(item, false);
}

/** Toast length a notice used before it moved into a dialog; the screen shows it at {@link NOTICE_TOAST_MS} after "Don't show this again". */
export const DEFAULT_TOAST_MS = 2200;
export const NOTICE_TOAST_MS = DEFAULT_TOAST_MS * 3;

/** One line that says what turning shell input on does, shown next to the "Turn on shell input" action. */
export const SHELL_INPUT_EXPLANATION =
  "Shell input lets a Paseo chat type your messages into this shell as commands. It is off by default; turning it on applies to this whole host.";

/** The plain-text route to the same switch, for anyone who prefers settings. */
export const SHELL_INPUT_SETTINGS_PATH = "Settings > Plugins > herdr-harness > Allow shell input";

/** What a pane's row offers. Pure so the tests can pin it: the row only renders these. */
export interface RowActions {
  /** Open the pane's Paseo chat (or bind one); never offered for a pane with no agent. */
  openAgent: "open" | "bind" | null;
  /** Open the pane as a Paseo terminal. Agent panes call it "Open in terminal"; plain panes "Open existing terminal". */
  openTerminal: boolean;
  newAgentHere: boolean;
  restart: boolean;
  /** A shell pane that can't take a chat because shell input is off: offer the switch. */
  turnOnShell: boolean;
}

export function rowActions(
  agent: { plain: boolean; isShell: boolean; paseoAgentId: string | null; provider: string | null; cwd: string | null; attach: unknown; canRestart: boolean },
  opts: { shellInput: boolean; canNavigate: boolean },
): RowActions {
  const { canNavigate, shellInput } = opts;
  const hasCwd = Boolean(agent.cwd);
  return {
    openAgent: !canNavigate ? null : agent.paseoAgentId ? "open" : !agent.plain && agent.provider && hasCwd ? "bind" : null,
    openTerminal: Boolean(canNavigate && agent.attach && hasCwd),
    // An agent pane without a chat is bound by "Open agent"; "New agent in this pane" is for a real shell with no chat yet.
    newAgentHere: Boolean(canNavigate && agent.plain && !agent.paseoAgentId && agent.provider && hasCwd && plainPaneBindable(agent, shellInput)),
    restart: agent.canRestart,
    turnOnShell: agent.plain && agent.isShell && !shellInput,
  };
}

/** The value a picked suggestion puts in the field: the path plus "/" so the user can keep drilling down. */
export function folderFieldValue(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

/** True when the daemon must expand the text (`~`, `~/x`) before it can be used as an absolute path. */
export function needsHomeExpansion(folder: string): boolean {
  const trimmed = folder.trim();
  return trimmed === "~" || trimmed.startsWith("~/");
}

export const FOLDER_SOURCE_LABELS = { herdr: "Herdr", paseo: "Paseo", filesystem: "" } as const;
export const FOLDER_SUGGEST_DEBOUNCE_MS = 150;
export const folderSuggestKey = (query: string) => ["herdr", "folders", query] as const;

/**
 * Chats to archive for a row's "Archive duplicate chats" action: the server's duplicate list
 * without the row's primary chat (the one the row opens), de-duplicated, in order.
 */
export function duplicateChatsToArchive(agent: { paseoAgentId: string | null; duplicateChatIds: readonly string[] }): string[] {
  const ids = new Set<string>();
  for (const id of agent.duplicateChatIds) if (id && id !== agent.paseoAgentId) ids.add(id);
  return [...ids];
}

/** The part of an overview agent row the archive re-check reads. */
interface DuplicateRow {
  terminalId: string;
  paneId: string;
  paseoAgentId: string | null;
  duplicateChatIds: readonly string[];
}

export type DuplicateArchivePlan =
  | { skip: null; archive: string[] }
  | { skip: "herdr-unavailable" | "chats-unavailable"; archive: []; detail: string }
  | { skip: "agent-gone" | "owner-changed" | "none-left"; archive: [] };

/** The part of a fresh `herdr.overview` answer the archive re-check reads. */
interface FreshOverview {
  connection: { status: "connected" } | { status: "unavailable"; error: string };
  chatError: string | null;
  workspaces: readonly { tabs: readonly { agents: readonly DuplicateRow[] }[] }[];
}

/**
 * Re-check an "Archive duplicate chats" tap against a fresh overview before archiving anything. Only ids
 * the user was shown AND the fresh row still lists as duplicates are archived, and only when the same
 * terminal and pane still has the same owner chat: if the owner changed (another chat became the newest)
 * the shown list may now contain the chat in use, so nothing is archived. A degraded overview (Herdr
 * unreachable, or Paseo's chat list unavailable so every row looks chat-less) archives nothing and says why.
 */
export function freshDuplicatesToArchive(shown: DuplicateRow, overview: FreshOverview): DuplicateArchivePlan {
  if (overview.connection.status === "unavailable") return { skip: "herdr-unavailable", archive: [], detail: overview.connection.error };
  if (overview.chatError !== null) return { skip: "chats-unavailable", archive: [], detail: overview.chatError };
  const fresh = overview.workspaces
    .flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.agents))
    .find((agent) => agent.terminalId === shown.terminalId && agent.paneId === shown.paneId);
  if (!fresh) return { skip: "agent-gone", archive: [] };
  if (fresh.paseoAgentId !== shown.paseoAgentId) return { skip: "owner-changed", archive: [] };
  const stillShown = new Set(duplicateChatsToArchive(shown));
  const archive = duplicateChatsToArchive(fresh).filter((id) => stillShown.has(id));
  return archive.length === 0 ? { skip: "none-left", archive: [] } : { skip: null, archive };
}

/** Toast text when the re-check archived nothing. */
export function duplicateArchiveSkippedMessage(plan: Exclude<DuplicateArchivePlan, { skip: null }>): string {
  switch (plan.skip) {
    case "herdr-unavailable":
      return `Nothing archived: Herdr couldn't be reached to check the chats (${plan.detail}).`;
    case "chats-unavailable":
      return `Nothing archived: Paseo's chat list is unavailable, so the chats can't be checked (${plan.detail}).`;
    case "agent-gone":
      return "Nothing archived: this agent is no longer listed.";
    case "owner-changed":
      return "Nothing archived: the agent's chat changed since this list was shown. Check the row and try again.";
    case "none-left":
      return "Nothing archived: those duplicate chats are already gone.";
  }
}

/**
 * Toast text for a partly failed archive, with the first failure's reason; null when every archive
 * worked (or none was tried). `total` is the number of chats the server tried to archive.
 */
export function archiveFailureMessage(total: number, failures: readonly { error: string }[]): string | null {
  if (failures.length === 0) return null;
  return `Couldn't archive ${failures.length} of ${total} duplicate chats: ${failures[0]!.error}`;
}

/** Button text for archiving `count` duplicate chats. */
export function archiveDuplicatesLabel(count: number): string {
  return `Archive ${count} duplicate ${count === 1 ? "chat" : "chats"}`;
}

/**
 * Warning for the top of the Herdr screen when the OMP input companion isn't current; null when there is
 * nothing to warn about (current, or OMP turned off). It names the command, never runs it.
 */
export function companionBanner(companion: CompanionStatus | undefined, ompEnabled: boolean): string | null {
  if (!companion || !ompEnabled || companion.state === "current") return null;
  const where = companion.path ? ` (${companion.path})` : "";
  switch (companion.state) {
    case "missing":
      return `The OMP input companion isn't installed, so OMP agents open read-only. To install it, ${COMPANION_INSTALL_STEP}, then restart your OMP agents.`;
    case "outdated":
      // Only the pre-rename file is reported by path: it is either alone or next to a current companion (two would be active).
      return companion.path?.endsWith(LEGACY_COMPANION_NAME)
        ? `The old OMP input companion ${LEGACY_COMPANION_NAME}${where} is still installed; OMP loads every file in that directory, so it must be replaced by ${COMPANION_INSTALL_NAME}. To fix it, ${COMPANION_INSTALL_STEP}, then restart your OMP agents.`
        : `The OMP input companion is outdated${where}. To update it, ${COMPANION_INSTALL_STEP}, then restart your OMP agents.`;
    case "foreign":
      return `A file that isn't this plugin's companion is in the way${where}. Inspect it; to replace it, run \`node scripts/install-omp-companion.mjs --force\` from the installed plugin directory, then restart your OMP agents.`;
    case "unknown":
      return "Couldn't check the OMP input companion (for example OMP's extensions directory is unreadable). See Troubleshooting: Companion missing, outdated or foreign.";
  }
}

/** The text "Copy diagnostics" puts on the clipboard (and shows when the clipboard isn't available). */
export function diagnosticsText(diagnostics: Diagnostics): string {
  return JSON.stringify(diagnostics, null, 2);
}
