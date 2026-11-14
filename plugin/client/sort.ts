import { agentLabel } from "./helpers.js";
import type { HerdrAgentStatus, OverviewAgent, OverviewWorkspace } from "../shared/rpc.js";
import { cacheColdAtMs } from "./time.js";

/**
 * Sorting and grouping for the Herdr screen. Pure: comparators read only the data they are given (never the clock), so rows
 * move when new data arrives and not on a timer tick.
 */

export type SortField =
  | "herdr" | "lastActivity" | "stateChanged" | "cacheCold" | "sessionStarted" | "status" | "title" | "harness" | "model"
  | "workspace" | "tab" | "pane" | "folder" | "hasChat" | "inputReady" | "duplicates";
export type SortDir = "asc" | "desc";
type FieldKind = "order" | "time" | "cache" | "status" | "text" | "number" | "flag";

interface FieldInfo { label: string; kind: FieldKind }

export const SORT_FIELDS: Record<SortField, FieldInfo> = {
  herdr: { label: "Herdr order", kind: "order" },
  lastActivity: { label: "Last activity", kind: "time" },
  stateChanged: { label: "State changed", kind: "time" },
  cacheCold: { label: "Cache cold at", kind: "cache" },
  sessionStarted: { label: "Session started", kind: "time" },
  status: { label: "Status", kind: "status" },
  title: { label: "Title", kind: "text" },
  harness: { label: "Harness", kind: "text" },
  model: { label: "Model", kind: "text" },
  workspace: { label: "Workspace", kind: "text" },
  tab: { label: "Tab", kind: "text" },
  pane: { label: "Pane", kind: "number" },
  folder: { label: "Folder", kind: "text" },
  hasChat: { label: "Has chat", kind: "flag" },
  inputReady: { label: "Input ready", kind: "flag" },
  duplicates: { label: "Duplicates", kind: "number" },
};
/** Picker order. */
export const SORT_FIELD_IDS = Object.keys(SORT_FIELDS) as SortField[];

export function isSortField(value: unknown): value is SortField {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SORT_FIELDS, value);
}

/** Most urgent first on ascending: blocked needs a person, then working, done, idle, unknown. */
export const STATUS_RANK: Record<HerdrAgentStatus, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };

/** The direction a field starts in when picked: times newest first, cache soonest cold first, status most urgent first. */
export function defaultDir(field: SortField): SortDir {
  const kind = SORT_FIELDS[field].kind;
  return kind === "time" || kind === "flag" ? "desc" : "asc";
}

/** Direction text that fits the field: newest first, A to Z, most urgent first. */
export function dirLabel(field: SortField, dir: SortDir): string {
  const up = dir === "asc";
  switch (SORT_FIELDS[field].kind) {
    case "order": return up ? "Pane order" : "Reverse pane order";
    case "time": return up ? "Oldest first" : "Newest first";
    case "cache": return up ? "Soonest cold first" : "Latest cold first";
    case "status": return up ? "Most urgent first" : "Least urgent first";
    case "text": return up ? "A→Z" : "Z→A";
    case "number": return up ? "Low to high" : "High to low";
    case "flag": return up ? "No first" : "Yes first";
  }
}

export interface SortView { field: SortField; dir: SortDir; grouped: boolean }
export const DEFAULT_VIEW: SortView = { field: "herdr", dir: "asc", grouped: true };

/** A stored or partial view made whole: an unknown field falls back to Herdr order, a missing direction to the field's default. */
export function normalizeView(raw: { field?: unknown; dir?: unknown; grouped?: unknown } | null | undefined): SortView {
  const field = isSortField(raw?.field) ? raw.field : DEFAULT_VIEW.field;
  const dir = raw?.dir === "asc" || raw?.dir === "desc" ? raw.dir : defaultDir(field);
  return { field, dir, grouped: typeof raw?.grouped === "boolean" ? raw.grouped : DEFAULT_VIEW.grouped };
}

/** Picking a field resets the direction to that field's default. */
export function pickField(view: SortView, field: SortField): SortView {
  return { ...view, field, dir: defaultDir(field) };
}

export const toggleDir = (view: SortView): SortView => ({ ...view, dir: view.dir === "asc" ? "desc" : "asc" });

/** One agent with the parent facts the client flattens onto it. */
export interface FlatAgent {
  agent: OverviewAgent;
  workspace: { id: string; number: number; label: string; cwd: string | null };
  tab: { id: string; number: number; label: string };
  /** How many panes (agents and plain terminals) the tab holds; a pane number is shown only when this is more than one. */
  tabPanes: number;
}

export function flattenOverview(workspaces: readonly OverviewWorkspace[]): FlatAgent[] {
  return workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.agents.map((agent): FlatAgent => ({
    agent,
    workspace: { id: workspace.workspaceId, number: workspace.number, label: workspace.label, cwd: workspace.cwd },
    tab: { id: tab.tabId, number: tab.number, label: tab.label },
    tabPanes: tab.agents.length,
  }))));
}

/** Herdr's own order: workspace, tab, pane number (unknown pane numbers last), then terminal id for a stable tie. */
export function compareHerdrOrder(a: FlatAgent, b: FlatAgent): number {
  return a.workspace.number - b.workspace.number
    || a.tab.number - b.tab.number
    || (a.agent.paneNumber ?? Number.MAX_SAFE_INTEGER) - (b.agent.paneNumber ?? Number.MAX_SAFE_INTEGER)
    || a.agent.terminalId.localeCompare(b.agent.terminalId);
}

const time = (iso: string | null): number | null => {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};
const text = (value: string | null | undefined): string | null => (value ? value.toLowerCase() : null);

/** The value a field sorts on; null = unknown, which sorts last in both directions. `herdr` has no value. */
export function sortValue(field: SortField, item: FlatAgent): number | string | null {
  const { agent } = item;
  switch (field) {
    case "herdr": return null;
    case "lastActivity": return time(agent.lastActivityAt);
    case "stateChanged": return time(agent.stateChangedAt);
    // A working agent is using its cache (the row says so), so it has no cold-at to rank.
    case "cacheCold": return agent.status === "working" || agent.plain ? null : cacheColdAtMs(agent.cache);
    case "sessionStarted": return time(agent.sessionStartedAt);
    // A pane with no agent has no agent status: it ranks after every agent state.
    case "status": return agent.plain ? Object.keys(STATUS_RANK).length : STATUS_RANK[agent.status];
    case "title": return text(agentLabel(agent));
    case "harness": return text(agent.harness ?? agent.kind);
    case "model": return text(agent.model);
    case "workspace": return text(item.workspace.label);
    case "tab": return text(item.tab.label);
    case "pane": return agent.paneNumber;
    case "folder": return text(agent.cwd);
    case "hasChat": return agent.paseoAgentId ? 1 : 0;
    case "inputReady": return agent.inputReady === null ? null : agent.inputReady ? 1 : 0;
    case "duplicates": return agent.duplicateChatIds.length;
  }
}

/** Comparator for a field and direction. Unknown values sort last whichever way it points; ties fall back to Herdr order. */
export function comparator(field: SortField, dir: SortDir): (a: FlatAgent, b: FlatAgent) => number {
  const sign = dir === "asc" ? 1 : -1;
  if (field === "herdr") return (a, b) => sign * compareHerdrOrder(a, b);
  return (a, b) => {
    const x = sortValue(field, a);
    const y = sortValue(field, b);
    if (x === null && y !== null) return 1;
    if (y === null && x !== null) return -1;
    if (x !== null && y !== null && x !== y) {
      const order = typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : (x as number) - (y as number);
      if (order !== 0) return sign * order;
    }
    return compareHerdrOrder(a, b);
  };
}

export function sortAgents(items: readonly FlatAgent[], field: SortField, dir: SortDir): FlatAgent[] {
  return [...items].sort(comparator(field, dir));
}

export interface AgentGroup {
  workspace: FlatAgent["workspace"];
  agents: FlatAgent[];
}

/**
 * Grouped mode: agents sorted inside each workspace card, cards ordered by their first agent (ties by workspace number).
 * A workspace with no agents keeps its place after the others, in workspace order. Flat mode is one card, `workspace` null.
 */
export function groupAgents(workspaces: readonly OverviewWorkspace[], view: SortView): AgentGroup[] {
  const compare = comparator(view.field, view.dir);
  const items = flattenOverview(workspaces);
  const groups: AgentGroup[] = workspaces.map((workspace) => ({
    workspace: { id: workspace.workspaceId, number: workspace.number, label: workspace.label, cwd: workspace.cwd },
    agents: items.filter((item) => item.workspace.id === workspace.workspaceId).sort(compare),
  }));
  return groups.sort((a, b) => {
    const first = a.agents[0];
    const other = b.agents[0];
    if (!first || !other) return first ? -1 : other ? 1 : a.workspace.number - b.workspace.number;
    return compare(first, other) || a.workspace.number - b.workspace.number;
  });
}

export function flatAgents(workspaces: readonly OverviewWorkspace[], view: SortView): FlatAgent[] {
  return sortAgents(flattenOverview(workspaces), view.field, view.dir);
}
