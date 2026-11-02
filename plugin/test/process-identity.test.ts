import { describe, expect, it, vi } from "vitest";
import { processGroupMembers, processInstanceId, type ProcessIdentityDeps } from "../server/harness/process-identity.js";

const psDeps = (stdout: string) => {
  const execFile = vi.fn<ProcessIdentityDeps["execFile"]>(async () => ({ stdout }));
  return { execFile, deps: { execFile, platform: "darwin" as const } };
};

/** Build a /proc stat line: pid (comm) state then fields 4..52, with starttime at field 22. */
const statLine = (pid: number, comm: string, starttime: string) => {
  const rest = Array.from({ length: 50 }, (_, i) => String(i + 4)); // fields 4..53
  rest[22 - 4] = starttime;
  return `${pid} (${comm}) S ${rest.join(" ")}\n`;
};

describe("processInstanceId", () => {
  it("returns pid@lstart, trimmed, from ps", async () => {
    const { deps } = psDeps("Thu Oct 30 22:13:44 2026\n");
    expect(await processInstanceId(4242, deps)).toBe("4242@Thu Oct 30 22:13:44 2026");
  });

  it("runs ps as an argv list with a 2 s timeout and LC_ALL=C, no shell", async () => {
    const { execFile, deps } = psDeps("Thu Oct 30 22:13:44 2026\n");
    await processInstanceId(77, deps);
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFile.mock.calls[0]!;
    expect(file).toBe("/bin/ps");
    expect(args).toEqual(["-o", "lstart=", "-p", "77"]);
    expect(options.timeout).toBe(2000);
    expect(options.env.LC_ALL).toBe("C");
    expect(options).not.toHaveProperty("shell");
  });

  it("different start times give different ids for the same pid", async () => {
    const a = await processInstanceId(9, psDeps("Thu Oct 30 22:13:44 2026").deps);
    const b = await processInstanceId(9, psDeps("Fri Oct 31 01:00:00 2026").deps);
    expect(a).not.toBe(b);
  });

  it("trims the trailing column padding real macOS ps emits after lstart", async () => {
    const { deps } = psDeps("Sat Oct 31 00:33:57 2026    \n");
    expect(await processInstanceId(9, deps)).toBe("9@Sat Oct 31 00:33:57 2026");
  });

  it("throws when ps fails", async () => {
    const deps = { execFile: async () => { throw new Error("ps exited 1"); }, platform: "darwin" as const };
    await expect(processInstanceId(9, deps)).rejects.toThrow(/ps exited 1/);
  });

  it("throws on empty or blank ps output", async () => {
    await expect(processInstanceId(9, psDeps("").deps)).rejects.toThrow(/no start time/);
    await expect(processInstanceId(9, psDeps("  \n").deps)).rejects.toThrow(/no start time/);
  });

  it("accepts a space-padded day of month", async () => {
    expect(await processInstanceId(9, psDeps("Sat Nov  7 03:04:05 2026\n").deps)).toBe("9@Sat Nov  7 03:04:05 2026");
  });

  it("throws on ps's `?` placeholder for a process it cannot inspect, so no shared id is returned", async () => {
    await expect(processInstanceId(1, psDeps("?\n").deps)).rejects.toThrow(/unrecognised start time/);
  });

  it("throws on any other non-lstart text", async () => {
    for (const text of ["garbage", "Thu Oct 30 22:13:44", "Thu Oct 30 22:13:44 2026 extra", "Thu Okt 30 22:13:44 2026", "jeu. oct. 30 22:13:44 2026", "ps: no such process"]) {
      await expect(processInstanceId(9, psDeps(text).deps), text).rejects.toThrow(/unrecognised start time/);
    }
  });

  it("rejects a non-positive or fractional pid without spawning", async () => {
    const { execFile, deps } = psDeps("x");
    for (const pid of [0, -1, 1.5, NaN]) await expect(processInstanceId(pid, deps)).rejects.toThrow(/invalid pid/);
    expect(execFile).not.toHaveBeenCalled();
  });

  describe("linux /proc", () => {
    const linux = (stat: string | Error) => {
      const readFile = vi.fn<ProcessIdentityDeps["readFile"]>(async () => { if (stat instanceof Error) throw stat; return stat; });
      const execFile = vi.fn<ProcessIdentityDeps["execFile"]>(async () => ({ stdout: "unused" }));
      return { readFile, execFile, deps: { readFile, execFile, platform: "linux" as const } };
    };

    it("reads field 22 of /proc/<pid>/stat and never runs ps", async () => {
      const { readFile, execFile, deps } = linux(statLine(321, "node", "123456789"));
      expect(await processInstanceId(321, deps)).toBe("321@123456789");
      expect(readFile.mock.calls[0]![0]).toBe("/proc/321/stat");
      expect(execFile).not.toHaveBeenCalled();
    });

    it("survives a comm with spaces and parentheses", async () => {
      const { deps } = linux(statLine(5, "my (weird) proc )x", "987"));
      expect(await processInstanceId(5, deps)).toBe("5@987");
    });

    it("throws when /proc cannot be read", async () => {
      await expect(processInstanceId(5, linux(new Error("ENOENT")).deps)).rejects.toThrow(/ENOENT/);
    });

    it("throws on a truncated or non-numeric stat", async () => {
      await expect(processInstanceId(5, linux("5 (node) S 1 2 3\n").deps)).rejects.toThrow(/malformed/);
      await expect(processInstanceId(5, linux("garbage").deps)).rejects.toThrow(/malformed/);
      await expect(processInstanceId(5, linux("").deps)).rejects.toThrow(/malformed/);
    });
  });
});

describe("processGroupMembers", () => {
  const listing = "    1     1\n  100   100\n  200   100\n  300   300\n";

  it("lists every pid of the group from ps -A, root processes included, as an argv list with a 2 s timeout and LC_ALL=C", async () => {
    const { execFile, deps } = psDeps(listing);
    expect(await processGroupMembers(100, deps)).toEqual([100, 200]);
    const [file, args, options] = execFile.mock.calls[0]!;
    expect(file).toBe("/bin/ps");
    expect(args).toEqual(["-A", "-o", "pid=,pgid="]);
    expect(options.timeout).toBe(2000);
    expect(options.env.LC_ALL).toBe("C");
    expect(options).not.toHaveProperty("shell");
  });

  it("returns a lone member, and nothing for a group ps does not list", async () => {
    expect(await processGroupMembers(300, psDeps(listing).deps)).toEqual([300]);
    expect(await processGroupMembers(999, psDeps(listing).deps)).toEqual([]);
  });

  it("throws on a ps failure, an empty listing and an unparseable line; never reads them as a lone shell", async () => {
    const failing = { execFile: vi.fn<ProcessIdentityDeps["execFile"]>(async () => { throw new Error("ps timed out"); }), platform: "darwin" as const };
    await expect(processGroupMembers(100, failing)).rejects.toThrow(/timed out/);
    await expect(processGroupMembers(100, psDeps("").deps)).rejects.toThrow(/no processes/);
    await expect(processGroupMembers(100, psDeps("  100   100\n  garbage\n").deps)).rejects.toThrow(/unrecognised/);
    await expect(processGroupMembers(100, psDeps("  100   ?\n").deps)).rejects.toThrow(/unrecognised/);
    await expect(processGroupMembers(0, psDeps(listing).deps)).rejects.toThrow(/invalid process group/);
  });
});

/** A typical mountinfo: a proc mount at /proc with default options, plus unrelated mounts. */
const NORMAL_MOUNTINFO = [
  "25 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
  "30 25 0:6 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw",
  "31 25 0:7 / /sys rw,nosuid shared:13 - sysfs sysfs rw",
].join("\n") + "\n";
const procMount = (superOptions: string) => NORMAL_MOUNTINFO.replace("- proc proc rw", `- proc proc ${superOptions}`);

describe("processGroupMembers on linux (/proc scan, no ps)", () => {
  /** A stat line: `pid (comm) S ppid pgrp ...`, enough fields to parse. */
  const procStat = (pid: number, pgrp: number, comm = "bash") => `${pid} (${comm}) S 1 ${pgrp} 1 0 -1 4194560 0 0 0 0\n`;
  const fakeProc = (entries: Record<string, string | Error>, extra: string[] = [], mountinfo = NORMAL_MOUNTINFO) => {
    const readdir = vi.fn<ProcessIdentityDeps["readdir"]>(async () => [...Object.keys(entries), ...extra]);
    const readFile = vi.fn<ProcessIdentityDeps["readFile"]>(async (path) => {
      if (path === "/proc/self/mountinfo") return mountinfo;
      const match = /^\/proc\/(\d+)\/stat$/.exec(path);
      const entry = match ? entries[match[1]!] : undefined;
      if (entry === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
      if (entry instanceof Error) throw entry;
      return entry;
    });
    const execFile = vi.fn<ProcessIdentityDeps["execFile"]>(async () => ({ stdout: "unused" }));
    return { readdir, readFile, execFile, deps: { readdir, readFile, execFile, platform: "linux" as const } };
  };

  it("lists the members of the group from field 5 of every numeric /proc entry, root included, and never runs ps", async () => {
    const { readdir, execFile, deps } = fakeProc({ "1": procStat(1, 1), "100": procStat(100, 100), "200": procStat(200, 100, "sudo"), "300": procStat(300, 300) }, ["self", "cpuinfo", "sys", "0", "007x"]);
    expect(await processGroupMembers(100, deps)).toEqual([100, 200]);
    expect(readdir.mock.calls[0]![0]).toBe("/proc");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("parses past a comm holding spaces and parentheses, so its text cannot shift the pgrp field", async () => {
    const { deps } = fakeProc({ "100": procStat(100, 100), "200": procStat(200, 777, "x) S 1 100 (y") });
    expect(await processGroupMembers(100, deps)).toEqual([100]);
  });

  it("returns a lone member, and nothing for a group no process holds", async () => {
    const entries = { "100": procStat(100, 100), "300": procStat(300, 300) };
    expect(await processGroupMembers(300, fakeProc(entries).deps)).toEqual([300]);
    expect(await processGroupMembers(999, fakeProc(entries).deps)).toEqual([]);
  });

  it("skips a pid that vanished between the listing and the read (ENOENT, ESRCH)", async () => {
    const { deps } = fakeProc({ "100": procStat(100, 100), "150": Object.assign(new Error("gone"), { code: "ESRCH" }), "200": procStat(200, 100) }, ["777"]);
    expect(await processGroupMembers(100, deps)).toEqual([100, 200]);
  });

  it("throws on any other read error, so a member it could not read is never taken as absent", async () => {
    const { deps } = fakeProc({ "100": procStat(100, 100), "200": Object.assign(new Error("EACCES"), { code: "EACCES" }) });
    await expect(processGroupMembers(100, deps)).rejects.toThrow(/EACCES/);
  });

  it("throws when /proc cannot be listed, is empty, or holds a malformed stat", async () => {
    const unlistable = { readdir: async () => { throw new Error("EMFILE"); }, readFile: async () => NORMAL_MOUNTINFO, execFile: async () => ({ stdout: "" }), platform: "linux" as const };
    await expect(processGroupMembers(100, unlistable)).rejects.toThrow(/EMFILE/);
    await expect(processGroupMembers(100, fakeProc({}, ["self"]).deps)).rejects.toThrow(/no processes/);
    await expect(processGroupMembers(100, fakeProc({ "100": procStat(100, 100), "200": "200 (bash) S 1\n" }).deps)).rejects.toThrow(/malformed/);
    await expect(processGroupMembers(100, fakeProc({ "100": "garbage" }).deps)).rejects.toThrow(/malformed/);
    await expect(processGroupMembers(100, fakeProc({ "100": "" }).deps)).rejects.toThrow(/malformed/);
  });

  it("refuses a /proc mounted with hidepid (other than 0/off) or subset=pid, before scanning anything", async () => {
    const entries = { "100": procStat(100, 100) };
    for (const options of ["rw,hidepid=2", "rw,hidepid=invisible", "rw,hidepid=1", "rw,hidepid=noaccess", "rw,hidepid=4,gid=1000", "rw,subset=pid", "rw,hidepid=0,subset=pid"]) {
      const { readdir, deps } = fakeProc(entries, [], procMount(options));
      await expect(processGroupMembers(100, deps), options).rejects.toThrow(/\/proc is mounted with/);
      expect(readdir).not.toHaveBeenCalled();
    }
    // The option can also sit in the per-mount options, and an overmounted /proc is checked as well.
    const perMount = NORMAL_MOUNTINFO.replace("/proc rw,nosuid", "/proc rw,hidepid=2,nosuid");
    await expect(processGroupMembers(100, fakeProc(entries, [], perMount).deps)).rejects.toThrow(/hidepid=2/);
    const overmount = NORMAL_MOUNTINFO + "40 30 0:8 / /proc rw shared:14 - proc proc rw,hidepid=2\n";
    await expect(processGroupMembers(100, fakeProc(entries, [], overmount).deps)).rejects.toThrow(/hidepid=2/);
  });

  it("scans a normal /proc mount, including hidepid=0 and hidepid=off", async () => {
    const entries = { "100": procStat(100, 100), "200": procStat(200, 100) };
    for (const options of ["rw", "rw,hidepid=0", "rw,hidepid=off", "rw,hidepid=0,gid=1000,subset=all"]) {
      expect(await processGroupMembers(100, fakeProc(entries, [], procMount(options)).deps), options).toEqual([100, 200]);
    }
  });

  it("throws when mountinfo is unreadable or shows no /proc mount, never assuming a normal one", async () => {
    const entries = { "100": procStat(100, 100) };
    await expect(processGroupMembers(100, fakeProc(entries, [], "").deps)).rejects.toThrow(/no \/proc mount/);
    await expect(processGroupMembers(100, fakeProc(entries, [], "25 1 8:1 / / rw - ext4 /dev/sda1 rw\n").deps)).rejects.toThrow(/no \/proc mount/);
    const { deps } = fakeProc(entries);
    const failing = { ...deps, readFile: async (path: string) => { if (path === "/proc/self/mountinfo") throw new Error("EACCES mountinfo"); return procStat(100, 100); } };
    await expect(processGroupMembers(100, failing)).rejects.toThrow(/EACCES mountinfo/);
  });

  it("fails closed when the scan outlasts the 2 s deadline (injected clock), and does not when it stays inside it", async () => {
    const entries = { "100": procStat(100, 100), "200": procStat(200, 100), "300": procStat(300, 300) };
    let clock = 0;
    const slow = fakeProc(entries);
    const reading = { ...slow.deps, now: () => clock, readFile: vi.fn<ProcessIdentityDeps["readFile"]>(async (path, enc) => { if (path === "/proc/200/stat") clock += 2001; return slow.deps.readFile(path, enc); }) };
    await expect(processGroupMembers(100, reading)).rejects.toThrow(/exceeded 2000 ms/);
    clock = 0;
    const quick = { ...slow.deps, now: () => clock, readFile: async (path: string, enc: "utf8") => { clock += 500; return slow.deps.readFile(path, enc); } };
    expect(await processGroupMembers(100, quick)).toEqual([100, 200]);
  });

  it("fails closed when a /proc read never returns (real 2 s timer)", async () => {
    vi.useFakeTimers();
    try {
      const stuck = { ...fakeProc({ "100": procStat(100, 100) }).deps, readFile: (path: string) => path === "/proc/self/mountinfo" ? Promise.resolve(NORMAL_MOUNTINFO) : new Promise<string>(() => {}) };
      const outcome = expect(processGroupMembers(100, stuck)).rejects.toThrow(/exceeded 2000 ms/);
      await vi.advanceTimersByTimeAsync(2001);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it("the macOS path still runs ps, never /proc", async () => {
    const readdir = vi.fn<ProcessIdentityDeps["readdir"]>(async () => ["100"]);
    const { execFile } = psDeps("  100   100\n");
    expect(await processGroupMembers(100, { execFile, readdir, platform: "darwin" })).toEqual([100]);
    expect(readdir).not.toHaveBeenCalled();
  });
});
