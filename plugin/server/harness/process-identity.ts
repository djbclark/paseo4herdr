import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

/** Injectable seams so tests never spawn a process or read /proc. */
export interface ProcessIdentityDeps {
  execFile: (file: string, args: string[], options: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  platform: NodeJS.Platform;
}

const PS_TIMEOUT_MS = 2000;
/** Absolute, not via PATH: exists on macOS and Linux. */
const PS_PATH = "/bin/ps";
/** C-locale `ps -o lstart=`: `Thu Oct 30 22:13:44 2026` (day space-padded). Anything else (e.g. `?` for a process ps cannot inspect) is not an identity. */
const LSTART = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d\d:\d\d:\d\d \d{4}$/;
const execFileAsync = promisify(execFile);

const defaultDeps: ProcessIdentityDeps = {
  execFile: async (file, args, options) => {
    const { stdout } = await execFileAsync(file, args, { ...options, encoding: "utf8" });
    return { stdout };
  },
  readFile: (path, encoding) => readFile(path, encoding),
  platform: process.platform,
};

/** `/proc/<pid>/stat` field 22 (starttime, clock ticks since boot). `comm` (field 2) is parenthesised and may hold spaces or parens. */
function linuxStartTime(stat: string): string {
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new Error("malformed /proc stat: no comm terminator");
  // After the comm field: state is field 3, so starttime (field 22) is index 19.
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const start = fields[19];
  if (!start || !/^\d+$/.test(start)) throw new Error("malformed /proc stat: no start time");
  return start;
}

/**
 * Identity of one process instance: `"<pid>@<start>"`. A reused pid has a different start time, so the id differs.
 * Throws on any failure, empty answer or unrecognised start time; an id is never guessed.
 *
 * Limits:
 * - macOS: `lstart` has 1 s resolution (a pid reused within the same second is indistinguishable) and follows
 *   /etc/localtime, which `TZ` cannot override. A system timezone change makes live agents read as replaced; that fails safe.
 * - Linux: the id is `pid@starttime-in-ticks-since-boot`, not stable across a reboot or across pid namespaces.
 * - A `ps` timeout or failure throws. Callers MUST treat a throw as "cannot validate, reject the prompt", never as
 *   "the process was replaced".
 */
export async function processInstanceId(pid: number, deps: Partial<ProcessIdentityDeps> = {}): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid pid: ${pid}`);
  const { execFile: run, readFile: read, platform } = { ...defaultDeps, ...deps };
  let start: string;
  if (platform === "linux") {
    start = linuxStartTime(await read(`/proc/${pid}/stat`, "utf8"));
  } else {
    const { stdout } = await run(PS_PATH, ["-o", "lstart=", "-p", String(pid)], { timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } });
    start = stdout.trim();
    if (!start) throw new Error(`ps returned no start time for pid ${pid}`);
    if (!LSTART.test(start)) throw new Error(`ps returned an unrecognised start time for pid ${pid}`);
  }
  return `${pid}@${start}`;
}

/**
 * Pids that are members of process group `pgid`, from `ps -A -o pid=,pgid=` (every process of every user, root included).
 * Herdr's own `foreground_processes` on macOS silently omits any process it cannot read (root, setuid: `sudo`, `su`), so it
 * cannot prove a group holds only the shell. Throws on a `ps` failure, an empty answer or any line that is not two integers:
 * callers read a throw as "unknown", never as "the group is alone".
 */
export async function processGroupMembers(pgid: number, deps: Partial<ProcessIdentityDeps> = {}): Promise<number[]> {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) throw new Error(`invalid process group: ${pgid}`);
  const { execFile: run } = { ...defaultDeps, ...deps };
  const { stdout } = await run(PS_PATH, ["-A", "-o", "pid=,pgid="], { timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } });
  const members: number[] = [];
  let rows = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) throw new Error("ps returned an unrecognised process listing");
    rows++;
    if (Number(match[2]) === pgid) members.push(Number(match[1]));
  }
  if (rows === 0) throw new Error("ps returned no processes");
  return members;
}
