import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FULL_READ_LIMIT, MAX_READ_BYTES, TranscriptSummaryCache, cleanIso, cleanModel, confinedSessionPath, foldTranscriptLines, EMPTY_SUMMARY } from "../server/activity.js";

const run = promisify(execFile);
const line = (o: object) => JSON.stringify(o);
const session = (at: string) => line({ type: "session", version: 3, timestamp: at });
const msg = (at: string, role: string) => line({ type: "message", timestamp: at, message: { role } });

let dir: string;
let roots: string[];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hardening-")); roots = [dir]; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("bounded reads", () => {
  it("a cached file that grows by more than one read folds only a bounded window, and still sees the newest line", async () => {
    const path = join(dir, "s.jsonl");
    await writeFile(path, session("2026-11-12T10:00:00.000Z") + "\n");
    const cache = new TranscriptSummaryCache();
    await cache.read(path, roots);
    const before = cache.bytesRequested;
    // Sparse growth of 64 MiB, then one real line.
    await truncate(path, 64 * 1024 * 1024);
    await appendFile(path, "\n" + msg("2026-11-12T11:00:00.000Z", "user") + "\n");
    const read = await cache.read(path, roots);
    expect(cache.bytesRequested - before).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(read?.summary).toMatchObject({ sessionStartedAt: "2026-11-12T10:00:00.000Z", lastUserAt: "2026-11-12T11:00:00.000Z" });
  });

  it("a huge sparse file is read from its head and tail only", async () => {
    const path = join(dir, "huge.jsonl");
    await writeFile(path, session("2026-11-12T10:00:00.000Z") + "\n");
    await truncate(path, 3 * 1024 * 1024 * 1024);
    await appendFile(path, "\n" + msg("2026-11-12T11:00:00.000Z", "assistant") + "\n");
    const cache = new TranscriptSummaryCache();
    const read = await cache.read(path, roots);
    expect(cache.bytesRequested).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(read?.summary.sessionStartedAt).toBe("2026-11-12T10:00:00.000Z");
    expect(read?.summary.lastAssistantAt).toBe("2026-11-12T11:00:00.000Z");
  });

  it("a file with no newline never grows the read past the cap", async () => {
    const path = join(dir, "flat.jsonl");
    await writeFile(path, "x".repeat(100));
    const cache = new TranscriptSummaryCache();
    await cache.read(path, roots);
    const before = cache.bytesRequested;
    await truncate(path, FULL_READ_LIMIT * 4);
    await cache.read(path, roots);
    expect(cache.bytesRequested - before).toBeLessThanOrEqual(MAX_READ_BYTES);
  });

  it("a failed read is not retried while the file is unchanged or inside the backoff, then is", async () => {
    const path = join(dir, "s.jsonl");
    await writeFile(path, session("2026-11-12T10:00:00.000Z") + "\n");
    let now = 1_000_000;
    const cache = new TranscriptSummaryCache(256, () => now);
    let attempts = 0;
    (cache as unknown as { window: () => Promise<string> }).window = async () => { attempts++; throw new Error("boom"); };
    expect(await cache.read(path, roots)).toBeNull();
    expect(attempts).toBe(1);
    await cache.read(path, roots);
    await cache.read(path, roots);
    expect(attempts).toBe(1); // unchanged file: left alone
    await appendFile(path, msg("2026-11-12T10:01:00.000Z", "user") + "\n");
    await cache.read(path, roots);
    expect(attempts).toBe(1); // changed, but inside the backoff
    now += 31_000;
    await cache.read(path, roots);
    expect(attempts).toBe(2);
  });

  it("concurrent callers share one read of the same file", async () => {
    const path = join(dir, "s.jsonl");
    await writeFile(path, session("2026-11-12T10:00:00.000Z") + "\n");
    const cache = new TranscriptSummaryCache();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => cache.read(path, roots)));
    expect(cache.reads).toBe(1);
    expect(new Set(results.map((r) => r?.summary.sessionStartedAt))).toEqual(new Set(["2026-11-12T10:00:00.000Z"]));
  });
});

describe("path confinement", () => {
  it("reads only .jsonl files inside the allowed roots", async () => {
    const inside = join(dir, "a.jsonl");
    await writeFile(inside, session("2026-11-12T10:00:00.000Z") + "\n");
    await writeFile(join(dir, "notes.txt"), "x\n");
    expect(await confinedSessionPath(inside, roots)).not.toBeNull();
    expect(await confinedSessionPath(join(dir, "notes.txt"), roots)).toBeNull();
    expect(await confinedSessionPath("relative.jsonl", roots)).toBeNull();
    expect(await confinedSessionPath(inside, [])).toBeNull();
    expect(await confinedSessionPath(join(dir, "..", "x.jsonl"), roots)).toBeNull();
    // A sibling directory that merely shares the root's name as a prefix is outside.
    const sibling = `${dir}-evil`;
    await mkdir(sibling);
    await writeFile(join(sibling, "a.jsonl"), "{}\n");
    try {
      expect(await confinedSessionPath(join(sibling, "a.jsonl"), roots)).toBeNull();
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it("refuses a symlink that points out of the root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    try {
      await writeFile(join(outside, "secret.jsonl"), session("2026-11-12T10:00:00.000Z") + "\n");
      await symlink(join(outside, "secret.jsonl"), join(dir, "link.jsonl"));
      await symlink(outside, join(dir, "linkdir"));
      const cache = new TranscriptSummaryCache();
      expect(await cache.read(join(dir, "link.jsonl"), roots)).toBeNull();
      expect(await cache.read(join(dir, "linkdir", "secret.jsonl"), roots)).toBeNull();
      expect(cache.reads).toBe(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("a FIFO is refused without blocking", async () => {
    const fifo = join(dir, "pipe.jsonl");
    await run("mkfifo", [fifo]);
    const cache = new TranscriptSummaryCache();
    expect(await Promise.race([cache.read(fifo, roots), new Promise((resolve) => setTimeout(() => resolve("blocked"), 3000))])).toBeNull();
  });

  it("a directory named like a session file is refused", async () => {
    await mkdir(join(dir, "d.jsonl"));
    expect(await new TranscriptSummaryCache().read(join(dir, "d.jsonl"), roots)).toBeNull();
  });
});

describe("untrusted transcript values", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  it("cleanIso accepts a strict ISO time in range and re-emits it canonically", () => {
    expect(cleanIso("2026-11-12T10:00:00Z", now)).toBe("2026-11-12T10:00:00.000Z");
    expect(cleanIso("2026-11-12T10:00:00.5+01:00", now)).toBe("2026-11-12T09:00:00.500Z");
  });
  it("cleanIso rejects out-of-range, lenient, long and non-string values", () => {
    expect(cleanIso("+275760-09-13T00:00:00.000Z", now)).toBeNull();
    expect(cleanIso("1999-12-31T23:59:59Z", now)).toBeNull();
    expect(cleanIso("2100-01-01T00:00:00Z", now)).toBeNull();
    expect(cleanIso(`2026-01-01 (${"x".repeat(5000)})`, now)).toBeNull();
    expect(cleanIso("Thu, 12 Nov 2026 10:00:00 GMT", now)).toBeNull();
    expect(cleanIso(12345, now)).toBeNull();
    expect(cleanIso(null, now)).toBeNull();
  });
  it("cleanModel caps length and charset", () => {
    expect(cleanModel("anthropic/claude-x.1:beta")).toBe("anthropic/claude-x.1:beta");
    expect(cleanModel("a".repeat(201))).toBeNull();
    expect(cleanModel("anthropic/<script>")).toBeNull();
    expect(cleanModel("")).toBeNull();
    expect(cleanModel({})).toBeNull();
  });
  it("a transcript full of hostile values yields no times and no model", () => {
    const summary = foldTranscriptLines(EMPTY_SUMMARY, [
      line({ type: "session", timestamp: "+275760-09-13T00:00:00.000Z" }),
      line({ type: "model_change", model: "anthropic/" + "x".repeat(500) }),
      line({ type: "message", timestamp: `2026-01-01 (${"x".repeat(9999)})`, message: { role: "assistant", provider: "anthropic", model: "<b>" } }),
    ]);
    expect(summary).toEqual(EMPTY_SUMMARY);
  });
});
