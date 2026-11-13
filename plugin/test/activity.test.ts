import { appendFile, mkdtemp, rename, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_SUMMARY, StateStamper, TranscriptSummaryCache, cacheInfo, foldTranscriptLines, laterIso, lastRequestAt, pickLastActivity } from "../server/activity.js";

const line = (o: object) => JSON.stringify(o);
const session = (at: string) => line({ type: "session", version: 3, id: "s", timestamp: at, cwd: "/w" });
const model = (at: string, m: string) => line({ type: "model_change", timestamp: at, model: m });
const msg = (at: string, role: string, extra: object = {}) => line({ type: "message", timestamp: at, message: { role, content: [], ...extra } });

describe("foldTranscriptLines", () => {
  it("takes session start, newest assistant and user times, and the latest model", () => {
    const summary = foldTranscriptLines(EMPTY_SUMMARY, [
      line({ type: "title", updatedAt: "2026-11-12T09:00:00.000Z" }),
      session("2026-11-12T10:00:00.000Z"),
      model("2026-11-12T10:00:01.000Z", "openai/gpt"),
      msg("2026-11-12T10:01:00.000Z", "user"),
      msg("2026-11-12T10:02:00.000Z", "assistant", { provider: "anthropic", model: "claude-x" }),
      msg("2026-11-12T10:03:00.000Z", "toolResult"),
    ]);
    expect(summary).toEqual({
      sessionStartedAt: "2026-11-12T10:00:00.000Z",
      lastAssistantAt: "2026-11-12T10:02:00.000Z",
      lastUserAt: "2026-11-12T10:03:00.000Z",
      model: "anthropic/claude-x",
    });
    expect(lastRequestAt(summary)).toBe("2026-11-12T10:03:00.000Z");
  });
  it("skips half-written lines and entries with no usable timestamp; never invents a time", () => {
    const summary = foldTranscriptLines(EMPTY_SUMMARY, ['{"type":"message","timestamp":"2026-11', "garbage", msg("not-a-date", "assistant"), msg("2026-11-12T10:00:00.000Z", "system")]);
    expect(summary).toEqual(EMPTY_SUMMARY);
  });
  it("title and model_change entries do not count as message times", () => {
    const summary = foldTranscriptLines(EMPTY_SUMMARY, [session("2026-11-12T10:00:00.000Z"), model("2026-11-12T11:00:00.000Z", "a/b")]);
    expect(summary.lastAssistantAt).toBeNull();
    expect(summary.lastUserAt).toBeNull();
    expect(lastRequestAt(summary)).toBeNull();
  });
});

describe("laterIso / pickLastActivity", () => {
  it("laterIso ignores missing or unparseable times", () => {
    expect(laterIso(null, null)).toBeNull();
    expect(laterIso("2026-11-12T10:00:00.000Z", null)).toBe("2026-11-12T10:00:00.000Z");
    expect(laterIso("junk", "2026-11-12T10:00:00.000Z")).toBe("2026-11-12T10:00:00.000Z");
    expect(laterIso("2026-11-12T11:00:00.000Z", "2026-11-12T10:00:00.000Z")).toBe("2026-11-12T11:00:00.000Z");
  });
  it("picks the newest evidence and says which it was", () => {
    expect(pickLastActivity({ transcriptAt: "2026-11-12T10:00:00.000Z", fileMtime: "2026-11-12T10:05:00.000Z", chatAt: "2026-11-12T10:02:00.000Z" })).toEqual({ at: "2026-11-12T10:05:00.000Z", source: "session-file" });
    expect(pickLastActivity({ transcriptAt: "2026-11-12T10:10:00.000Z", fileMtime: "2026-11-12T10:05:00.000Z", chatAt: null })?.source).toBe("transcript");
    expect(pickLastActivity({ transcriptAt: null, fileMtime: null, chatAt: "2026-11-12T10:02:00.000Z" })?.source).toBe("chat");
    expect(pickLastActivity({ transcriptAt: null, fileMtime: null, chatAt: null })).toBeNull();
  });
});

describe("cacheInfo", () => {
  const summary = { ...EMPTY_SUMMARY, lastAssistantAt: "2026-11-12T10:02:00.000Z", lastUserAt: "2026-11-12T10:03:00.000Z" };
  it("only the anthropic/ provider prefix gets an estimate", () => {
    expect(cacheInfo("anthropic/claude-x", summary)).toEqual({ provider: "anthropic", anchorAt: "2026-11-12T10:03:00.000Z", ttlSec: 300, ttlKnown: false });
    expect(cacheInfo("openai-codex/gpt-6.1-sol", summary)).toBeNull();
    expect(cacheInfo("proxy/claude-sonnet", summary)).toBeNull(); // "claude" behind a proxy is no proof
    expect(cacheInfo("claude-sonnet", summary)).toBeNull();
    expect(cacheInfo(null, summary)).toBeNull();
  });
  it("no message time: still Anthropic, anchor unknown; 1 hour only with proof", () => {
    expect(cacheInfo("anthropic/c", EMPTY_SUMMARY)).toMatchObject({ anchorAt: null, ttlSec: 300 });
    expect(cacheInfo("anthropic/c", summary, true)).toMatchObject({ ttlSec: 3600, ttlKnown: true });
  });
});

describe("StateStamper", () => {
  const t0 = Date.parse("2026-11-12T12:00:00.000Z");
  it("first sight is a lower bound, not an exact time", () => {
    const stamper = new StateStamper();
    expect(stamper.get("k")).toBeNull();
    expect(stamper.observe("k", "idle", 4, t0)).toMatchObject({ at: "2026-11-12T12:00:00.000Z", exact: false });
  });
  it("an unchanged sample keeps the stamp", () => {
    const stamper = new StateStamper();
    const first = stamper.observe("k", "idle", 4, t0);
    expect(stamper.observe("k", "idle", 4, t0 + 60_000)).toBe(first);
  });
  it("a status change is stamped exact at the sample time", () => {
    const stamper = new StateStamper();
    stamper.observe("k", "idle", 4, t0);
    expect(stamper.observe("k", "blocked", 4, t0 + 5000)).toMatchObject({ at: "2026-11-12T12:00:05.000Z", exact: true, status: "blocked" });
  });
  it("a sequence bump with the same status is a change", () => {
    const stamper = new StateStamper();
    stamper.observe("k", "working", 4, t0);
    expect(stamper.observe("k", "working", 5, t0 + 5000)).toMatchObject({ exact: true, seq: 5 });
  });
  it("a drop in the sequence (Herdr restarted) is a change too", () => {
    const stamper = new StateStamper();
    stamper.observe("k", "idle", 40, t0);
    expect(stamper.observe("k", "idle", 2, t0 + 5000)).toMatchObject({ at: "2026-11-12T12:00:05.000Z", exact: true, seq: 2 });
  });
  it("forgets agents that are gone, so a returning pane is first sight again", () => {
    const stamper = new StateStamper();
    stamper.observe("a", "idle", 1, t0);
    stamper.observe("b", "idle", 1, t0);
    stamper.retain(new Set(["a"]));
    expect(stamper.get("b")).toBeNull();
    expect(stamper.observe("b", "idle", 1, t0 + 1000).exact).toBe(false);
    expect(stamper.get("a")).not.toBeNull();
  });
});

describe("TranscriptSummaryCache", () => {
  let dir: string;
  let roots: string[];
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "activity-test-")); roots = [dir]; });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("parses once, then serves an unchanged file (same path, mtime and size) from the cache", async () => {
    const path = join(dir, "s.jsonl");
    await writeFile(path, [session("2026-11-12T10:00:00.000Z"), msg("2026-11-12T10:01:00.000Z", "assistant", { provider: "anthropic", model: "c" })].join("\n") + "\n");
    const cache = new TranscriptSummaryCache();
    const first = await cache.read(path, roots);
    expect(first?.summary).toMatchObject({ sessionStartedAt: "2026-11-12T10:00:00.000Z", lastAssistantAt: "2026-11-12T10:01:00.000Z", model: "anthropic/c" });
    expect(first?.mtime).toMatch(/^\d{4}-/);
    await cache.read(path, roots);
    await cache.read(path, roots);
    expect(cache.reads).toBe(1);
  });

  it("reads only the appended tail when the file grows, and keeps what the head said", async () => {
    const path = join(dir, "s.jsonl");
    await writeFile(path, session("2026-11-12T10:00:00.000Z") + "\n");
    const cache = new TranscriptSummaryCache();
    await cache.read(path, roots);
    await appendFile(path, msg("2026-11-12T10:05:00.000Z", "user") + "\n");
    const after = await cache.read(path, roots);
    expect(after?.summary).toMatchObject({ sessionStartedAt: "2026-11-12T10:00:00.000Z", lastUserAt: "2026-11-12T10:05:00.000Z" });
    expect(cache.reads).toBe(2);
  });

  it("holds back a half-written last line until it is complete", async () => {
    const path = join(dir, "s.jsonl");
    const full = msg("2026-11-12T10:05:00.000Z", "user");
    await writeFile(path, session("2026-11-12T10:00:00.000Z") + "\n" + full.slice(0, 20));
    const cache = new TranscriptSummaryCache();
    expect((await cache.read(path, roots))?.summary.lastUserAt).toBeNull();
    await appendFile(path, full.slice(20) + "\n");
    expect((await cache.read(path, roots))?.summary.lastUserAt).toBe("2026-11-12T10:05:00.000Z");
  });

  it("a file that shrank is read again from the start", async () => {
    const path = join(dir, "s.jsonl");
    await writeFile(path, [session("2026-11-12T10:00:00.000Z"), msg("2026-11-12T10:05:00.000Z", "user"), msg("2026-11-12T10:06:00.000Z", "user")].join("\n") + "\n");
    const cache = new TranscriptSummaryCache();
    await cache.read(path, roots);
    await writeFile(path, session("2026-11-12T11:00:00.000Z") + "\n");
    expect((await cache.read(path, roots))?.summary).toMatchObject({ sessionStartedAt: "2026-11-12T11:00:00.000Z", lastUserAt: null });
  });

  it("a file rewritten in place at the same size with a new mtime is read afresh", async () => {
    const path = join(dir, "s.jsonl");
    await writeFile(path, session("2026-11-12T10:00:00.000Z") + "\n");
    const cache = new TranscriptSummaryCache();
    await cache.read(path, roots);
    await writeFile(path, session("2026-11-12T11:00:00.000Z") + "\n");
    await utimes(path, new Date(), new Date(Date.now() + 5000));
    expect((await cache.read(path, roots))?.summary.sessionStartedAt).toBe("2026-11-12T11:00:00.000Z");
  });

  it("a file replaced by another inode at the same size and mtime is read afresh", async () => {
    const path = join(dir, "s.jsonl");
    const when = new Date(Date.now() - 60_000);
    await writeFile(path, session("2026-11-12T10:00:00.000Z") + "\n");
    await utimes(path, when, when);
    const cache = new TranscriptSummaryCache();
    await cache.read(path, roots);
    const next = join(dir, "next.tmp");
    await writeFile(next, session("2026-11-12T11:00:00.000Z") + "\n");
    await utimes(next, when, when);
    await rename(next, path);
    expect((await cache.read(path, roots))?.summary.sessionStartedAt).toBe("2026-11-12T11:00:00.000Z");
  });

  it("a missing file is null, not an error", async () => {
    expect(await new TranscriptSummaryCache().read(join(dir, "nope.jsonl"), roots)).toBeNull();
  });

  it("a large file is summarised from its head and tail", async () => {
    const path = join(dir, "big.jsonl");
    const filler = line({ type: "custom_message", content: "x".repeat(1000) });
    const body = [session("2026-11-12T10:00:00.000Z"), model("2026-11-12T10:00:01Z", "anthropic/old")];
    for (let i = 0; i < 4500; i++) body.push(filler);
    body.push(msg("2026-11-12T11:30:00.000Z", "assistant", { provider: "anthropic", model: "new" }));
    await writeFile(path, body.join("\n") + "\n");
    const cache = new TranscriptSummaryCache();
    const read = await cache.read(path, roots);
    expect(read?.summary).toMatchObject({ sessionStartedAt: "2026-11-12T10:00:00.000Z", lastAssistantAt: "2026-11-12T11:30:00.000Z", model: "anthropic/new" });
    await appendFile(path, msg("2026-11-12T11:40:00.000Z", "user") + "\n");
    expect((await cache.read(path, roots))?.summary.lastUserAt).toBe("2026-11-12T11:40:00.000Z");
    await truncate(path, 0);
  });
});
