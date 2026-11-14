import { describe, expect, it } from "vitest";
import { shellGateEpoch } from "../shared/settings.js";
import { withShellSwitch, archiveDuplicatesLabel, archiveFailureMessage, companionBanner, duplicateArchiveSkippedMessage, duplicateChatsToArchive, freshDuplicatesToArchive, folderFieldValue, needsHomeExpansion, agentLabel, describeTarget, NOTICE_TOAST_MS, DEFAULT_TOAST_MS, PICKER_LIMIT, pickerItems, pickerPlace, rowActions, paneText, pathTail, placeText, plainState, plainRowTitle, plainPaneBindable, statusLabel, statusTone, tabText, validateFolder, workspaceText } from "../client/helpers.js";

describe("withShellSwitch", () => {
  const base = { herdrSession: "s", allowShell: false, allowShellEpoch: 0 };
  it("turning the switch on stores a new epoch, and a second enable never reuses one", () => {
    const first = withShellSwitch(base, true, 1000);
    expect(first).toEqual({ herdrSession: "s", allowShell: true, allowShellEpoch: 1000 });
    const off = withShellSwitch(first, false, 2000);
    expect(off.allowShell).toBe(false);
    expect(withShellSwitch(off, true, 3000).allowShellEpoch).toBe(3000);
    expect(withShellSwitch(off, true, 1000).allowShellEpoch).toBe(2001); // same clock reading: still a different epoch
  });

  it("the off-save stores a new epoch too, so a later write that only flips the boolean to true matches no binding's epoch", () => {
    const on = withShellSwitch(base, true, 1000);
    const bindingEpoch = shellGateEpoch(on); // a chat opts in under this epoch, then is closed
    const off = withShellSwitch(on, false, 2000);
    expect(off.allowShellEpoch).toBe(2000);
    expect(shellGateEpoch(off)).toBeNull();
    const flipped = { ...off, allowShell: true }; // e.g. a generic plugin-settings write that changes only the boolean
    expect(shellGateEpoch(flipped)).not.toBeNull();
    expect(shellGateEpoch(flipped)).not.toBe(bindingEpoch);
  });

  it("a repeated clock reading on the off move still advances the epoch", () => {
    const on = withShellSwitch(base, true, 1000);
    expect(withShellSwitch(on, false, 1000).allowShellEpoch).toBe(1001);
  });
});

describe("client helpers", () => {
  it("labels and tones statuses", () => {
    expect(statusLabel("blocked")).toBe("Blocked");
    expect(statusTone("working")).toBe("accent");
    expect(statusTone("unknown")).toBe("muted");
  });
  it("validates folder", () => {
    expect(validateFolder("  ")).toBe("Enter a folder path");
    expect(validateFolder("/tmp")).toBeNull();
  });
  it("describes target", () => {
    const lines = describeTarget({
      socketPath: "/s", herdrSession: null, source: "default", autoStart: false, autoStartDisabledReason: "x",
    });
    expect(lines).toEqual(["Socket: /s", "Session: default", "Auto-start: off"]);
  });
  it("accepts ~ folders and detects when the daemon must expand them", () => {
    expect(validateFolder("~/code")).toBeNull();
    expect(needsHomeExpansion(" ~ ")).toBe(true);
    expect(needsHomeExpansion("~/code")).toBe(true);
    expect(needsHomeExpansion("~user/code")).toBe(false);
    expect(needsHomeExpansion("/abs/~")).toBe(false);
  });
  it("picked folders get one trailing slash", () => {
    expect(folderFieldValue("/a/b")).toBe("/a/b/");
    expect(folderFieldValue("/a/b/")).toBe("/a/b/");
  });
  it("pathTail", () => {
    expect(pathTail("/a/b/")).toBe("b");
  });
});

describe("agentLabel", () => {
  const base = { title: null, name: null, kind: "omp", terminalId: "term_1" };
  it("prefers the terminal title without its prompt glyph", () => {
    expect(agentLabel({ ...base, title: "π > What can you do" })).toBe("What can you do");
  });
  it("falls back to name, kind, then terminal id", () => {
    expect(agentLabel({ ...base, title: "π > ", name: "paseo-abc123" })).toBe("paseo-abc123");
    expect(agentLabel(base)).toBe("omp");
    expect(agentLabel({ ...base, kind: null })).toBe("term_1");
  });
  it("archives only the duplicates, never the row's primary chat", () => {
    expect(duplicateChatsToArchive({ paseoAgentId: "new", duplicateChatIds: ["old1", "old2"] })).toEqual(["old1", "old2"]);
    expect(duplicateChatsToArchive({ paseoAgentId: "new", duplicateChatIds: ["old1", "new", "old1", ""] })).toEqual(["old1"]);
    expect(duplicateChatsToArchive({ paseoAgentId: null, duplicateChatIds: [] })).toEqual([]);
  });
  describe("fresh duplicate re-check before archiving", () => {
    interface Row { terminalId: string; paneId: string; paseoAgentId: string | null; duplicateChatIds: string[] }
    const row = (over: Partial<Row> = {}): Row =>
      ({ terminalId: "t1", paneId: "p1", paseoAgentId: "owner", duplicateChatIds: ["dupA", "dupB"], ...over });
    const fresh = (workspaces: unknown[], over: Record<string, unknown> = {}) =>
      ({ connection: { status: "connected" as const }, chatError: null, workspaces, ...over }) as Parameters<typeof freshDuplicatesToArchive>[1];
    const overview = (...agents: Row[]) => fresh([{ tabs: [{ agents: [row({ terminalId: "other", paneId: "px", duplicateChatIds: ["dupA"] })] }, { agents }] }]);
    it("archives every shown duplicate when the fresh row is unchanged", () => {
      expect(freshDuplicatesToArchive(row(), overview(row()))).toEqual({ skip: null, archive: ["dupA", "dupB"] });
    });
    it("archives nothing when the owner changed, even if the shown ids are still listed or one is the new owner", () => {
      expect(freshDuplicatesToArchive(row(), overview(row({ paseoAgentId: "dupB", duplicateChatIds: ["owner", "dupA"] })))).toEqual({ skip: "owner-changed", archive: [] });
      expect(freshDuplicatesToArchive(row(), overview(row({ paseoAgentId: null })))).toEqual({ skip: "owner-changed", archive: [] });
    });
    it("skips a duplicate that is no longer listed and never adds one the user wasn't shown", () => {
      expect(freshDuplicatesToArchive(row(), overview(row({ duplicateChatIds: ["dupB", "dupNew"] })))).toEqual({ skip: null, archive: ["dupB"] });
    });
    it("archives nothing when no shown duplicate is left", () => {
      expect(freshDuplicatesToArchive(row(), overview(row({ duplicateChatIds: [] })))).toEqual({ skip: "none-left", archive: [] });
      expect(freshDuplicatesToArchive(row(), overview(row({ duplicateChatIds: ["dupNew"] })))).toEqual({ skip: "none-left", archive: [] });
    });
    it("archives nothing when the agent row is gone or the pane is not the same one", () => {
      expect(freshDuplicatesToArchive(row(), fresh([]))).toEqual({ skip: "agent-gone", archive: [] });
      expect(freshDuplicatesToArchive(row(), overview(row({ terminalId: "t2" })))).toEqual({ skip: "agent-gone", archive: [] });
      expect(freshDuplicatesToArchive(row(), overview(row({ paneId: "p2" })))).toEqual({ skip: "agent-gone", archive: [] });
    });
    it("finds the row in any workspace and tab, and never uses another agent's duplicates", () => {
      const workspaces = [{ tabs: [{ agents: [row({ terminalId: "t0", paneId: "p0", duplicateChatIds: ["dupA", "dupB"] })] }] }, { tabs: [{ agents: [] }, { agents: [row({ duplicateChatIds: ["dupB"] })] }] }];
      expect(freshDuplicatesToArchive(row(), fresh(workspaces))).toEqual({ skip: null, archive: ["dupB"] });
    });
    it("names the real cause when the fresh overview is degraded, before it looks at any row", () => {
      const rows = [{ tabs: [{ agents: [row({ paseoAgentId: null, duplicateChatIds: [] })] }] }];
      const herdrDown = freshDuplicatesToArchive(row(), fresh([], { connection: { status: "unavailable", error: "Herdr is not running" } }));
      expect(herdrDown).toEqual({ skip: "herdr-unavailable", archive: [], detail: "Herdr is not running" });
      const noChats = freshDuplicatesToArchive(row(), fresh(rows, { chatError: "agents.list failed" }));
      expect(noChats).toEqual({ skip: "chats-unavailable", archive: [], detail: "agents.list failed" });
      if (herdrDown.skip === null || noChats.skip === null) throw new Error("expected a skip");
      expect(duplicateArchiveSkippedMessage(herdrDown)).toBe("Nothing archived: Herdr couldn't be reached to check the chats (Herdr is not running).");
      expect(duplicateArchiveSkippedMessage(noChats)).toBe("Nothing archived: Paseo's chat list is unavailable, so the chats can't be checked (agents.list failed).");
    });
    it("words each reason to skip", () => {
      expect(duplicateArchiveSkippedMessage({ skip: "owner-changed", archive: [] })).toContain("chat changed");
      expect(duplicateArchiveSkippedMessage({ skip: "agent-gone", archive: [] })).toContain("no longer listed");
      expect(duplicateArchiveSkippedMessage({ skip: "none-left", archive: [] })).toContain("already gone");
    });
  });
  it("names the first failure in a partial archive and says nothing when all worked", () => {
    expect(archiveFailureMessage(3, [{ error: "agent is busy" }, { error: "second" }])).toBe("Couldn't archive 2 of 3 duplicate chats: agent is busy");
    expect(archiveFailureMessage(1, [{ error: "Something went wrong" }])).toBe("Couldn't archive 1 of 1 duplicate chats: Something went wrong");
    expect(archiveFailureMessage(2, [])).toBeNull();
    expect(archiveFailureMessage(0, [])).toBeNull();
  });
  it("words the archive-duplicates action by count", () => {
    expect(archiveDuplicatesLabel(1)).toBe("Archive 1 duplicate chat");
    expect(archiveDuplicatesLabel(3)).toBe("Archive 3 duplicate chats");
  });
  it("shows no companion banner when current or when OMP is off", () => {
    expect(companionBanner({ state: "current", path: "/e/paseo4herdr-input.ts" }, true)).toBeNull();
    expect(companionBanner({ state: "missing", path: "/e/paseo4herdr-input.ts" }, false)).toBeNull();
  });
  it("shows no companion banner when the daemon sent no companion state", () => {
    expect(companionBanner(undefined, true)).toBeNull();
    expect(companionBanner(undefined, false)).toBeNull();
  });
  it("words the companion banner per state and names the fix command", () => {
    const fix = "paseo plugin update herdr-harness";
    const script = "node scripts/install-omp-companion.mjs";
    const missing = companionBanner({ state: "missing", path: "/e/paseo4herdr-input.ts" }, true)!;
    expect(missing).toContain("isn't installed");
    expect(missing).toContain(fix);
    expect(missing).toContain(script);
    const outdated = companionBanner({ state: "outdated", path: "/e/paseo4herdr-input.ts" }, true)!;
    expect(outdated).toContain("is outdated (/e/paseo4herdr-input.ts)");
    expect(outdated).toContain(fix);
    const foreign = companionBanner({ state: "foreign", path: "/e/paseo4herdr-input.ts" }, true)!;
    expect(foreign).toContain("/e/paseo4herdr-input.ts");
    expect(foreign).toContain(`${script} --force`);
    expect(companionBanner({ state: "unknown" }, true)).toContain("Couldn't check");
  });
  it("explains the two-companion outdated case that points at the legacy file", () => {
    const text = companionBanner({ state: "outdated", path: "/e/paseo-herdr-input.ts" }, true)!;
    expect(text).toContain("old OMP input companion paseo-herdr-input.ts (/e/paseo-herdr-input.ts)");
    expect(text).toContain("paseo4herdr-input.ts");
    expect(text).toContain("paseo plugin update herdr-harness");
    expect(text).not.toContain("is outdated");
  });
});

describe("Herdr names", () => {
  it("workspace, tab and pane use Herdr's own wording, never W/T/P codes", () => {
    expect(workspaceText({ number: 3, label: "misc" })).toBe("misc");
    expect(workspaceText({ number: 3, label: " " })).toBe("workspace 3");
    expect(tabText({ number: 26, label: "codexbar" })).toBe("codexbar");
    expect(tabText({ number: 2, label: "2" })).toBe("tab 2");
    expect(paneText({ paneLabel: "logs", paneNumber: 1 }, 1)).toBe("logs");
    expect(paneText({ paneLabel: null, paneNumber: 2 }, 1)).toBe("");
    expect(paneText({ paneLabel: null, paneNumber: 2 }, 3)).toBe("pane 2");
    expect(paneText({ paneLabel: null, paneNumber: null }, 3)).toBe("");
    const item = { workspace: { number: 26, label: "codexbar" }, tab: { number: 1, label: "src" }, tabPanes: 2, agent: { paneLabel: null, paneNumber: 1 } };
    expect(placeText(item, false)).toBe("codexbar › src › pane 1");
    expect(placeText(item, true)).toBe("src › pane 1");
  });
  it("plainPaneBindable offers a new agent only on agent panes and real shells", () => {
    expect(plainPaneBindable({ plain: false, isShell: false }, false)).toBe(true);
    expect(plainPaneBindable({ plain: true, isShell: true }, true)).toBe(true);
    expect(plainPaneBindable({ plain: true, isShell: true }, false)).toBe(false);
    expect(plainPaneBindable({ plain: true, isShell: false }, true)).toBe(false);
  });
  it("plainRowTitle names a plain row once", () => {
    expect(plainRowTitle({ isShell: false, program: "vim" }, "vim")).toEqual({ state: "vim", name: null });
    expect(plainRowTitle({ isShell: true, program: "zsh" }, "zsh")).toEqual({ state: "zsh", name: null });
    expect(plainRowTitle({ isShell: true, program: "zsh" }, "dev shell")).toEqual({ state: "Shell", name: "dev shell" });
    expect(plainRowTitle({ isShell: false, program: null }, "term_1")).toEqual({ state: "Terminal", name: "term_1" });
  });
  it("plainState says Shell or the program, never an agent status", () => {
    expect(plainState({ isShell: true, program: "zsh" })).toBe("Shell");
    expect(plainState({ isShell: false, program: "vim" })).toBe("vim");
    expect(plainState({ isShell: false, program: null })).toBe("Terminal");
  });
});

import { overviewAgentSchema } from "../shared/rpc.js";
import type { FlatAgent } from "../client/sort.js";

const flat = (extra: object = {}, id = "t1", where: Partial<Pick<FlatAgent, "workspace" | "tab" | "tabPanes">> = {}): FlatAgent => ({
  agent: overviewAgentSchema.parse({
    terminalId: id, paneId: `w1:${id}`, name: null, title: id, kind: "omp", harness: "OMP", provider: "herdr-omp", status: "idle", cwd: "/repo",
    paseoAgentId: null, attachCommand: "herdr agent attach x", attach: { command: "/bin/herdr", args: ["agent", "attach", "x"] }, inputReady: null, canRestart: false, paneNumber: 1, ...extra,
  }),
  workspace: { id: "w1", number: 1, label: "alpha-api", cwd: "/repo" },
  tab: { id: "tab1", number: 1, label: "tests" },
  tabPanes: 1,
  ...where,
});
const plainPane = (extra: object = {}, id = "sh1", where: Partial<Pick<FlatAgent, "workspace" | "tab" | "tabPanes">> = {}) =>
  flat({ kind: null, harness: null, provider: "herdr-generic", status: "unknown", title: null, plain: true, isShell: true, program: "zsh", ...extra }, id, where);

describe("pickerItems", () => {
  const items = [
    flat({ title: "Fix tests" }, "a1"),
    flat({ title: "Refactor" }, "a2", { workspace: { id: "w2", number: 2, label: "gamma-ops", cwd: "/ops" }, tab: { id: "tab2", number: 2, label: "deploy" } }),
    plainPane({ program: "vim", isShell: false }, "p1"),
    plainPane({ paneLabel: "dev shell" }, "p2", { tabPanes: 2 }),
  ];
  it("lists only panes with a detected agent for the agent picker, and only panes with none for the terminal picker", () => {
    expect(pickerItems(items, "agent", "").map((i) => i.agent.terminalId)).toEqual(["a1", "a2"]);
    expect(pickerItems(items, "terminal", "").map((i) => i.agent.terminalId)).toEqual(["p1", "p2"]);
  });
  it("filters on workspace, tab and pane names as well as title, program and folder, ignoring case and padding", () => {
    expect(pickerItems(items, "agent", " GAMMA ").map((i) => i.agent.terminalId)).toEqual(["a2"]);
    expect(pickerItems(items, "agent", "deploy").map((i) => i.agent.terminalId)).toEqual(["a2"]);
    expect(pickerItems(items, "agent", "fix").map((i) => i.agent.terminalId)).toEqual(["a1"]);
    expect(pickerItems(items, "terminal", "dev shell").map((i) => i.agent.terminalId)).toEqual(["p2"]);
    expect(pickerItems(items, "terminal", "vim").map((i) => i.agent.terminalId)).toEqual(["p1"]);
    expect(pickerItems(items, "terminal", "/repo")).toHaveLength(2);
    expect(pickerItems(items, "terminal", "nothing like it")).toEqual([]);
  });
  it("never lists anything that is not in the Herdr overview it is given, and cuts the list to the limit", () => {
    expect(pickerItems([], "agent", "")).toEqual([]);
    const many = Array.from({ length: PICKER_LIMIT + 5 }, (_, i) => flat({}, `m${i}`));
    expect(pickerItems(many, "agent", "")).toHaveLength(PICKER_LIMIT);
  });
  it("names the place with Herdr's own workspace, tab and pane names", () => {
    expect(pickerPlace(items[3]!)).toBe("alpha-api › tests › dev shell");
    expect(pickerPlace(items[0]!)).toBe("alpha-api › tests");
  });
});

describe("rowActions", () => {
  const go = { shellInput: false, canNavigate: true };
  it("gives an agent with a chat Open existing agent, and one without a chat Open agent (bind), plus Open in terminal", () => {
    expect(rowActions(flat({ paseoAgentId: "chat" }).agent, go)).toEqual({ openAgent: "open", openTerminal: true, newAgentHere: false, restart: false, turnOnShell: false });
    expect(rowActions(flat().agent, go)).toMatchObject({ openAgent: "bind", newAgentHere: false, turnOnShell: false });
  });
  it("gives a plain terminal Open existing terminal and no chat button", () => {
    expect(rowActions(plainPane({ program: "vim", isShell: false }).agent, go)).toEqual({ openAgent: null, openTerminal: true, newAgentHere: false, restart: false, turnOnShell: false });
  });
  it("offers a shell the switch while shell input is off, and New agent in this pane once it is on", () => {
    expect(rowActions(plainPane().agent, go)).toMatchObject({ newAgentHere: false, turnOnShell: true, openTerminal: true });
    expect(rowActions(plainPane().agent, { ...go, shellInput: true })).toMatchObject({ newAgentHere: true, turnOnShell: false });
    expect(rowActions(plainPane({ program: "vim", isShell: false }).agent, { ...go, shellInput: true }).newAgentHere).toBe(false);
  });
  it("offers nothing that needs navigation without it, nor a terminal without an attach command, and shows restart when possible", () => {
    expect(rowActions(flat({ paseoAgentId: "c" }).agent, { ...go, canNavigate: false })).toMatchObject({ openAgent: null, openTerminal: false });
    expect(rowActions(flat({ attach: null }).agent, go).openTerminal).toBe(false);
    expect(rowActions(flat({ canRestart: true }).agent, go).restart).toBe(true);
  });
});

describe("shell notice toast", () => {
  it("is three times the default toast length once the dialog is turned off", () => {
    expect(NOTICE_TOAST_MS).toBe(DEFAULT_TOAST_MS * 3);
    expect(NOTICE_TOAST_MS).toBe(6600);
  });
});
