import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderEventSchema, type ProviderConnection, type ProviderEvent, type ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { createHerdrProvider } from "../server/provider.js";
import { genericAdapter } from "../server/harness/generic/adapter.js";
import { HERDR_BIND_OPTION } from "../shared/model.js";

vi.mock("../server/harness/process-identity.js", () => ({ processInstanceId: vi.fn(async (pid: number) => `${pid}@Sat Oct 31 00:33:57 2026`), processGroupMembers: vi.fn(async (pgid: number) => [pgid]) }));

const config: ProviderSessionConfig = { cwd: "/work", env: {}, mcpServers: {}, settings: {}, persist: true };
const bound = (extra: Record<string, unknown> = {}): ProviderSessionConfig =>
  ({ ...config, providerOptions: { [HERDR_BIND_OPTION]: { terminalId: "t-shell", paneId: "pane-shell", ...extra } } });

let server: Server | undefined;
let directory: string | undefined;
const connections: ProviderConnection[] = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
  server = undefined;
  directory = undefined;
});

const paneRow = { pane_id: "pane-shell", terminal_id: "t-shell", workspace_id: "w", tab_id: "t", focused: true, agent: null, agent_status: "unknown", revision: 1, cwd: "/work" };
const agentRow = { terminal_id: "t-shell", pane_id: "pane-shell", agent: "grok", name: null, agent_status: "idle", workspace_id: "w", tab_id: "t", focused: true, revision: 1, cwd: "/work" };

async function rig(listedAgents: unknown[] = [], shellAllowed: boolean | Error = true) {
  directory = await mkdtemp(join(tmpdir(), "herdr-shell-bind-"));
  const socket = join(directory, "herdr.sock");
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  server = createServer((stream) => {
    let bytes = "";
    stream.setEncoding("utf8");
    // A client that closes first must not turn the reply write into an uncaught EPIPE.
    stream.on("error", () => {});
    stream.on("data", (chunk: string) => {
      bytes += chunk;
      if (!bytes.includes("\n")) return;
      const request = JSON.parse(bytes.slice(0, bytes.indexOf("\n"))) as { id: string; method: string; params: Record<string, unknown> };
      sent.push({ method: request.method, params: request.params });
      if (request.method === "events.subscribe") {
        stream.write(JSON.stringify({ id: request.id, result: { type: "subscription_started" } }) + "\n");
        return;
      }
      const result = request.method === "pane.process_info" ? { type: "pane_process_info", process_info: {
          pane_id: "pane-shell", shell_pid: 100, foreground_process_group_id: 100, tty: "/dev/ttys001", foreground_processes: [{ pid: 100, name: "zsh", argv: ["zsh"] }] } } :
        request.method === "agent.list" ? { type: "agent_list", agents: listedAgents } :
        request.method === "pane.list" ? { type: "pane_list", panes: [paneRow] } :
        request.method === "pane.read" ? { type: "pane_read", read: { pane_id: "pane-shell", text: "$ " } } : { type: "ok" };
      stream.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  await new Promise<void>((resolve) => server?.listen(socket, resolve));
  const provider = createHerdrProvider(genericAdapter, async () => socket, { getHerdrSession: () => null, bindHistoryDelayMs: 60_000, shellEpoch: async () => { if (shellAllowed instanceof Error) throw shellAllowed; return shellAllowed ? 7 : null; } });
  const connection = await provider.connect({ versions: [1], capabilities: ["session.list", "session.persistence", "prompt.message"] });
  connections.push(connection);
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(ProviderEventSchema.parse(event)));
  const open = (requestId: string, sessionConfig: ProviderSessionConfig) =>
    connection.send({ type: "session.open", requestId, sessionId: "s1", config: sessionConfig, history: "skip" });
  const failure = async (requestId: string) => {
    await vi.waitFor(() => expect(events.some((event) => event.type === "request.failed" && event.requestId === requestId)).toBe(true));
    const event = events.find((candidate) => candidate.type === "request.failed" && candidate.requestId === requestId);
    return event && event.type === "request.failed" ? event.error.message : "";
  };
  return { connection, events, sent, open, failure };
}

it("binds a plain shell only with allowShell: the flag and the shell occupant persist, and a prompt is typed then submitted with Enter", async () => {
  const { connection, events, sent, open } = await rig();
  await open("open", bound({ allowShell: true }));
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.ready")).toBe(true));
  const opened = events.find((event) => event.type === "session.opened");
  expect(opened && opened.type === "session.opened" && opened.persistence?.data).toMatchObject({ allowShell: true, allowShellEpoch: 7, terminalId: "t-shell", occupant: { pid: 100, shell: true } });
  expect(events.some((event) => event.type === "session.notice" && event.notice.description === "Prompt text runs as shell commands.")).toBe(true);
  await connection.send({ type: "session.prompt", sessionId: "s1", prompt: { clientMessageId: "p1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "echo hi" }] } } });
  await vi.waitFor(() => expect(events.some((event) => event.type === "session.prompt_result" && event.result.type === "turn")).toBe(true));
  expect(sent.filter((r) => r.method === "pane.send_text" || r.method === "pane.send_keys")).toEqual([
    { method: "pane.send_keys", params: { pane_id: "pane-shell", keys: ["ctrl+e", "ctrl+u"] } },
    { method: "pane.send_text", params: { pane_id: "pane-shell", text: "echo hi" } },
    { method: "pane.send_keys", params: { pane_id: "pane-shell", keys: ["enter"] } },
  ]);
});

it("without allowShell the shell pane is not even listed: the bind fails and pane.list is never asked", async () => {
  const { sent, open, failure } = await rig();
  await open("open", bound());
  expect(await failure("open")).toMatch(/no longer running/);
  expect(sent.some((request) => request.method === "pane.list")).toBe(false);
});

it("allowShell on a pane where Herdr detects an agent is refused", async () => {
  const { open, failure } = await rig([agentRow]);
  await open("open", bound({ allowShell: true }));
  expect(await failure("open")).toMatch(/shell input applies only to plain shell panes/);
});

it("allowShell at bind says the setting could not be read, not that it is off, when the read fails; nothing is listed", async () => {
  const { sent, open, failure } = await rig([], new Error("EIO"));
  await open("open", bound({ allowShell: true }));
  const message = await failure("open");
  expect(message).toMatch(/could not be read.*EIO.*try again/);
  expect(message).not.toMatch(/turned off/);
  expect(sent.some((request) => request.method === "pane.list" || request.method.startsWith("pane.send"))).toBe(false);
});

it("allowShell is refused at bind while the plugin setting is off, and the shell pane is not even listed", async () => {
  const { sent, open, failure } = await rig([], false);
  await open("open", bound({ allowShell: true }));
  expect(await failure("open")).toMatch(/turned off in the Herdr plugin settings/);
  expect(sent.some((request) => request.method === "pane.list" || request.method.startsWith("pane.send"))).toBe(false);
});
