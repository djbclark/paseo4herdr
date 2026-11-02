import { describe, expect, it } from "vitest";
import { createShellEpochCache, type GateSettings } from "../server/shell-epoch-cache.js";

type State = Parameters<Parameters<GateSettings["subscribe"]>[0]>[0];

/** A settings handle whose stored state, read failure and listeners the test drives. */
function fakeSettings(initial: State) {
  const listeners = new Set<(state: State) => void | Promise<void>>();
  const store = { state: initial, readError: null as Error | null, reads: 0 };
  const settings: GateSettings = {
    read: async () => { store.reads++; if (store.readError) throw store.readError; return store.state; },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const notify = (state: State) => { store.state = state; for (const listener of listeners) void listener(state); };
  return { settings, store, notify, listenerCount: () => listeners.size };
}
const ready = (allowShell: boolean, allowShellEpoch: number): State => ({ status: "ready", values: { allowShell, allowShellEpoch } });

describe("createShellEpochCache", () => {
  it("is unknown before the first read or notification, and a read does not need a notification", async () => {
    const { settings } = fakeSettings(ready(true, 1700));
    const cache = createShellEpochCache(settings);
    expect(cache.now()).toBe("unknown");
    await expect(cache.read()).resolves.toBe(1700);
    expect(cache.now()).toBe(1700);
  });

  it("a ready notification gives the epoch while the gate is open, and null (read, closed) when it is off or has no epoch", () => {
    const { settings, notify } = fakeSettings(ready(false, 0));
    const cache = createShellEpochCache(settings);
    notify(ready(true, 1700));
    expect(cache.now()).toBe(1700);
    notify(ready(false, 1700));
    expect(cache.now()).toBeNull();
    notify(ready(true, 0));
    expect(cache.now()).toBeNull();
  });

  it("an invalid notification gives unknown, not closed, and the next ready one recovers", () => {
    const { settings, notify } = fakeSettings(ready(true, 5));
    const cache = createShellEpochCache(settings);
    notify(ready(true, 5));
    notify({ status: "invalid", error: "bad document" });
    expect(cache.now()).toBe("unknown");
    notify(ready(true, 6));
    expect(cache.now()).toBe(6);
  });

  it("a read that throws gives unknown and rejects, after a good value was cached", async () => {
    const { settings, store } = fakeSettings(ready(true, 5));
    const cache = createShellEpochCache(settings);
    await cache.read();
    expect(cache.now()).toBe(5);
    store.readError = new Error("EIO");
    await expect(cache.read()).rejects.toThrow(/EIO/);
    expect(cache.now()).toBe("unknown");
    store.readError = null;
    await expect(cache.read()).resolves.toBe(5);
    expect(cache.now()).toBe(5);
  });

  it("an invalid document on a read rejects with its error and gives unknown", async () => {
    const { settings } = fakeSettings({ status: "invalid", revision: "1", error: "bad document" } as State);
    const cache = createShellEpochCache(settings);
    await expect(cache.read()).rejects.toThrow(/bad document/);
    expect(cache.now()).toBe("unknown");
  });

  it("a notification after a read replaces the cached value without another read (the Enter guard's source)", async () => {
    const { settings, store, notify } = fakeSettings(ready(true, 9));
    const cache = createShellEpochCache(settings);
    await cache.read();
    notify(ready(false, 9));
    expect(cache.now()).toBeNull();
    expect(store.reads).toBe(1);
  });

  it("stop unsubscribes", () => {
    const { settings, notify, listenerCount } = fakeSettings(ready(true, 3));
    const cache = createShellEpochCache(settings);
    expect(listenerCount()).toBe(1);
    cache.stop();
    expect(listenerCount()).toBe(0);
    notify(ready(true, 4));
    expect(cache.now()).toBe("unknown");
  });
});

describe("createShellEpochCache read ordering", () => {
  it("a read that started before a notification does not overwrite it, and still returns the value it read", async () => {
    const listeners = new Set<(state: State) => void | Promise<void>>();
    let finish!: (state: State) => void;
    const settings: GateSettings = {
      read: () => new Promise<State>((resolve) => { finish = resolve; }),
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const cache = createShellEpochCache(settings);
    const pending = cache.read();
    for (const listener of listeners) void listener(ready(false, 1700));
    expect(cache.now()).toBeNull();
    finish(ready(true, 1700));
    await expect(pending).resolves.toBe(1700);
    expect(cache.now()).toBeNull();
  });
});
