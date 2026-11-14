import { describe, expect, it, vi } from "vitest";
import { bindHerdrChat, bindNewPane, createHerdrChat, openHerdrTerminal } from "../client/actions.js";
import { registerHerdrHome } from "../client/home.js";
import { createPaseoApi } from "@getpaseo/client";

describe("createHerdrChat", () => {
  const pane = { label: "proj", paneId: "w9:p1", terminalId: "t-9", cwd: "/repo", shellInput: true };
  it("opens a Herdr workspace and binds a chat to its pane; it never asks Paseo to launch the OMP provider", async () => {
    // Exercise the real SDK: mocking workspace.agents.create hid its provider/model validation.
    const createAgent = vi.fn(async () => ({ id: "chat-1" }));
    const openProject = vi.fn(async () => ({ workspace: { id: "folder-workspace", workspaceDirectory: "/repo" } }));
    const createWorkspace = vi.fn(async () => pane);
    const ready = vi.fn(async () => ({ flushed: 0 }));
    const paseo = createPaseoApi({ openProject, createAgent } as never);
    try {
      expect(await createHerdrChat(paseo, ready, " /repo ", createWorkspace)).toEqual({ agentId: "chat-1", note: null });
      expect(createWorkspace).toHaveBeenCalledExactlyOnceWith("/repo");
      expect(createAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        config: expect.objectContaining({ provider: "herdr-generic", providerOptions: { herdrBind: { terminalId: "t-9", paneId: "w9:p1", allowShell: true } } }),
      }));
      expect(JSON.stringify(createAgent.mock.calls)).not.toContain("herdr-omp");
      expect(ready).toHaveBeenCalledExactlyOnceWith({ terminalId: "t-9" });
    } finally { await paseo.dispose(); }
  });
  it("opens the pane but binds nothing while shell input is off, and says so", async () => {
    const open = vi.fn();
    const result = await createHerdrChat({ workspaces: { open } } as never, async () => ({}), "/repo", async () => ({ ...pane, shellInput: false }));
    expect(result.agentId).toBeNull();
    expect(result.note).toMatch(/Opened a new terminal in proj/);
    expect(open).not.toHaveBeenCalled();
  });
  it("opens the new pane as a Paseo terminal when shell input is off and the pane can be attached", async () => {
    const create = vi.fn(async () => ({}));
    const open = vi.fn(async () => ({ id: "paseo-ws", terminals: { create } }));
    const attach = { command: "/bin/herdr", args: ["terminal", "attach", "t-9"] };
    const result = await createHerdrChat({ workspaces: { open } } as never, async () => ({}), "/repo", async () => ({ ...pane, shellInput: false, attach }));
    expect(result).toEqual({ agentId: null, workspaceId: "paseo-ws", note: null });
    expect(open).toHaveBeenCalledExactlyOnceWith("/repo");
    expect(create).toHaveBeenCalledExactlyOnceWith({ name: "Herdr: proj", command: "/bin/herdr", args: ["terminal", "attach", "t-9"] });
  });
  it("still prefers a bound chat when shell input is on, whatever the pane can attach", async () => {
    const createAgent = vi.fn(async () => ({ id: "chat-5" }));
    const openProject = vi.fn(async () => ({ workspace: { id: "w", workspaceDirectory: "/repo" } }));
    const paseo = createPaseoApi({ openProject, createAgent } as never);
    try {
      const attach = { command: "/bin/herdr", args: ["terminal", "attach", "t-9"] };
      expect(await createHerdrChat(paseo, async () => ({}), "/repo", async () => ({ ...pane, attach }))).toEqual({ agentId: "chat-5", note: null });
    } finally { await paseo.dispose(); }
  });
  it("names the settings path in the note when the pane can't be opened as a terminal either", async () => {
    const result = await createHerdrChat({} as never, async () => ({}), "/repo", async () => ({ ...pane, shellInput: false, attach: null }));
    expect(result.agentId).toBeNull();
    expect(result.note).toContain("Settings > Plugins > herdr-harness > Allow shell input");
  });
  it("says so when the terminal can't be opened after the pane exists", async () => {
    const open = vi.fn(async () => { throw new Error("Folder unavailable"); });
    const attach = { command: "/bin/herdr", args: [] };
    await expect(createHerdrChat({ workspaces: { open } } as never, async () => ({}), "/repo", async () => ({ ...pane, shellInput: false, attach }))).rejects.toThrow(/Opened a new terminal in proj, but couldn't open it here: Folder unavailable/);
  });
  it("resolves a ~ folder through the daemon and passes the absolute path on", async () => {
    const resolve = vi.fn(async () => "/home/me/proj");
    const createWorkspace = vi.fn(async () => ({ ...pane, shellInput: false }));
    await createHerdrChat({} as never, async () => ({}), " ~/proj ", createWorkspace, resolve);
    expect(resolve).toHaveBeenCalledWith("~/proj");
    expect(createWorkspace).toHaveBeenCalledExactlyOnceWith("/home/me/proj");
    await expect(createHerdrChat({} as never, async () => ({}), "~/x", createWorkspace, async () => null)).rejects.toThrow("absolute");
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });
  it("refuses an empty folder before creating anything, and explains a failed attach after the pane exists", async () => {
    const createWorkspace = vi.fn(async () => pane);
    await expect(createHerdrChat({} as never, async () => ({}), "  ", createWorkspace)).rejects.toThrow("Enter a folder path");
    expect(createWorkspace).not.toHaveBeenCalled();
    const open = vi.fn(async () => { throw new Error("Folder unavailable"); });
    await expect(createHerdrChat({ workspaces: { open } } as never, async () => ({}), "/gone", createWorkspace)).rejects.toThrow(/Opened a new terminal in proj, but couldn't attach a chat to it: Folder unavailable/);
  });
});

describe("openHerdrTerminal", () => {
  it("opens the folder's workspace and runs the attach command in a terminal without a shell", async () => {
    const create = vi.fn(async () => ({}));
    const open = vi.fn(async () => ({ id: "ws-1", terminals: { create } }));
    const id = await openHerdrTerminal({ workspaces: { open } } as never, { cwd: "/repo", attach: { command: "/bin/herdr", args: ["agent", "attach", "x"] }, name: "Herdr: x" });
    expect(id).toBe("ws-1");
    expect(create).toHaveBeenCalledExactlyOnceWith({ name: "Herdr: x", command: "/bin/herdr", args: ["agent", "attach", "x"] });
  });
  it("refuses a pane with no attach command or no folder before touching Paseo", async () => {
    const open = vi.fn();
    await expect(openHerdrTerminal({ workspaces: { open } } as never, { cwd: "/repo", attach: null, name: "x" })).rejects.toThrow(/can't be opened as a terminal/);
    await expect(openHerdrTerminal({ workspaces: { open } } as never, { cwd: null, attach: { command: "h", args: [] }, name: "x" })).rejects.toThrow(/can't be opened as a terminal/);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("bindNewPane", () => {
  it("falls back to the workspace folder when Herdr reports none for the pane, and binds nothing without any folder", async () => {
    const createAgent = vi.fn(async () => ({ id: "chat-7" }));
    const openProject = vi.fn(async () => ({ workspace: { id: "ws", workspaceDirectory: "/ws" } }));
    const paseo = createPaseoApi({ openProject, createAgent } as never);
    try {
      const fresh = { terminalId: "t", paneId: "p", cwd: null, shellInput: true };
      expect(await bindNewPane(paseo, async () => ({}), fresh, "/ws", "api")).toEqual({ agentId: "chat-7", note: null });
      expect(openProject).toHaveBeenCalledExactlyOnceWith("/ws", undefined);
      expect((await bindNewPane(paseo, async () => ({}), fresh, null, "api")).agentId).toBeNull();
    } finally { await paseo.dispose(); }
  });
});

describe("bindHerdrChat", () => {
  const agent = { terminalId: "term-1", paneId: "w1:p2", provider: "herdr-omp", cwd: "/repo" };
  it("creates a chat bound to the running agent in its folder's workspace, then asks for its history", async () => {
    const createAgent = vi.fn(async () => ({ id: "chat-2" }));
    const openProject = vi.fn(async () => ({ workspace: { id: "folder-workspace", workspaceDirectory: "/repo" } }));
    const ready = vi.fn(async () => ({ flushed: 1 }));
    const paseo = createPaseoApi({ openProject, createAgent } as never);
    try {
      expect(await bindHerdrChat(paseo, ready, agent, "Fix tests")).toBe("chat-2");
      expect(createAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        workspaceId: "folder-workspace",
        config: expect.objectContaining({ provider: "herdr-omp", model: "native-default", cwd: "/repo", title: "Fix tests",
          providerOptions: { herdrBind: { terminalId: "term-1", paneId: "w1:p2" } } }),
      }));
      expect(ready).toHaveBeenCalledExactlyOnceWith({ terminalId: "term-1" });
      expect(ready.mock.invocationCallOrder[0]).toBeGreaterThan(createAgent.mock.invocationCallOrder[0]);
    } finally { await paseo.dispose(); }
  });

  it("binds a pane with no agent as shell input", async () => {
    const createAgent = vi.fn(async () => ({ id: "chat-4" }));
    const paseo = createPaseoApi({ openProject: async () => ({ workspace: { id: "w", workspaceDirectory: "/repo" } }), createAgent } as never);
    try {
      await bindHerdrChat(paseo, async () => ({}), { ...agent, provider: "herdr-generic", plain: true }, "zsh");
      expect(createAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        config: expect.objectContaining({ providerOptions: { herdrBind: { terminalId: "term-1", paneId: "w1:p2", allowShell: true } } }),
      }));
    } finally { await paseo.dispose(); }
  });

  it("still opens the chat when the history request fails, and refuses an agent without a provider", async () => {
    const paseo = createPaseoApi({
      openProject: async () => ({ workspace: { id: "w", workspaceDirectory: "/repo" } }),
      createAgent: async () => ({ id: "chat-3" }),
    } as never);
    try {
      expect(await bindHerdrChat(paseo, async () => { throw new Error("offline"); }, agent, "x")).toBe("chat-3");
      await expect(bindHerdrChat(paseo, async () => ({}), { ...agent, provider: null }, "x")).rejects.toThrow(/can't be opened/);
    } finally { await paseo.dispose(); }
  });
});

function home() {
  let observer: { snapshot(input: any): void; update(input: any): void };
  const subscribe = vi.fn((value: typeof observer) => { observer = value; });
  const list = vi.fn(async (_options: unknown) => ({ subscription: { subscribe } }));
  const buttons: { remove: ReturnType<typeof vi.fn>; input: any }[] = [];
  const addComposerPill = vi.fn((input: any) => {
    const remove = vi.fn();
    buttons.push({ input, remove });
    return { update: vi.fn(), remove };
  });
  const openScreen = vi.fn();
  const cleanup = registerHerdrHome({ paseo: { agents: { list } }, addComposerPill, openScreen } as never);
  return { list, subscribe, buttons, addComposerPill, openScreen, cleanup,
    snapshot: (agents: object[], pageInfo = { hasMore: false, nextCursor: null as string | null }) => observer.snapshot({ entries: agents.map((agent) => ({ agent })), pageInfo }),
    update: (payload: object) => observer.update({ type: "agent_update", payload }),
  };
}
const agent = (id: string, extra: object = {}) => ({ id, provider: "herdr-omp", workspaceId: "w1", archivedAt: null, ...extra });

describe("Herdr home buttons", () => {
  it("only adds buttons to Herdr chats and opens the global home", async () => {
    const h = home();
    await vi.waitFor(() => expect(h.subscribe).toHaveBeenCalledOnce());
    h.snapshot([agent("a"), agent("b", { provider: "codex" }), agent("c", { archivedAt: "today" }), agent("d", { workspaceId: null })]);
    expect(h.addComposerPill).toHaveBeenCalledOnce();
    expect(h.buttons[0].input).toMatchObject({ agentId: "a", workspaceId: "w1" });
    h.buttons[0].input.button.behavior.onPress();
    expect(h.openScreen).toHaveBeenCalledExactlyOnceWith({ screenId: "herdr-overview" });
    h.cleanup();
  });
  it("handles moves, archive, deletion, reconnect and cleanup without duplicate registrations", async () => {
    const h = home();
    await vi.waitFor(() => expect(h.subscribe).toHaveBeenCalledOnce());
    h.snapshot([agent("a")]);
    h.update({ kind: "upsert", agent: agent("a") });
    expect(h.addComposerPill).toHaveBeenCalledTimes(1);
    h.update({ kind: "upsert", agent: agent("a", { workspaceId: "w2" }) });
    expect(h.buttons[0].remove).toHaveBeenCalledOnce();
    expect(h.buttons[1].input.workspaceId).toBe("w2");
    h.snapshot([agent("b")]);
    expect(h.buttons[1].remove).toHaveBeenCalledOnce();
    h.update({ kind: "remove", agentId: "b" });
    expect(h.buttons[2].remove).toHaveBeenCalledOnce();
    h.update({ kind: "upsert", agent: agent("c") });
    h.update({ kind: "upsert", agent: agent("c", { archivedAt: "today" }) });
    expect(h.buttons[3].remove).toHaveBeenCalledOnce();
    h.update({ kind: "upsert", agent: agent("d") });
    h.cleanup();
    expect((h.list.mock.calls[0][0] as { signal: AbortSignal }).signal.aborted).toBe(true);
    expect(h.buttons[4].remove).toHaveBeenCalledOnce();
    h.update({ kind: "upsert", agent: agent("e") });
    expect(h.addComposerPill).toHaveBeenCalledTimes(5);
    h.cleanup();
    expect(h.buttons[4].remove).toHaveBeenCalledOnce();
  });
  it("does not register a late subscription after cleanup", async () => {
    const h = home();
    h.cleanup();
    await Promise.resolve();
    expect(h.subscribe).not.toHaveBeenCalled();
  });
  it("includes older pages while respecting a newer archive update", async () => {
    const h = home();
    await vi.waitFor(() => expect(h.subscribe).toHaveBeenCalledOnce());
    h.list.mockResolvedValueOnce({ entries: [{ agent: agent("older") }, { agent: agent("archived") }], pageInfo: { hasMore: false, nextCursor: null } } as never);
    h.snapshot([agent("a")], { hasMore: true, nextCursor: "page-2" });
    h.update({ kind: "upsert", agent: agent("archived", { archivedAt: "today" }) });
    await vi.waitFor(() => expect(h.addComposerPill).toHaveBeenCalledTimes(2));
    expect(h.buttons.map((b) => b.input.agentId)).toEqual(["a", "older"]);
    h.cleanup();
  });
});
