import { shellGateEpoch, type ShellGate } from "../shared/settings.js";

type GateValues = { allowShell: boolean; allowShellEpoch: number };
type GateState = { status: "ready"; values: GateValues } | { status: "invalid"; error: string };

/** The part of Paseo's plugin settings handle the cache uses. */
export interface GateSettings {
  read(): Promise<GateState>;
  subscribe(listener: (state: GateState) => void | Promise<void>): () => unknown;
}

export interface ShellEpochCache {
  /** Fresh read of the setting; refreshes the cache. Rejects when the setting cannot be read (the cache is then `"unknown"`). */
  read(): Promise<number | null>;
  /** Synchronous view for the checks between the last foreground look and a write, where no I/O is allowed. */
  now(): ShellGate;
  stop(): void;
}

/**
 * The shell gate as last seen: `"unknown"` until the first read or notification and again after an unreadable or invalid
 * setting, else the open epoch or `null` (read, and closed). Fed by the settings subscription and by every read. Callers
 * refuse on `"unknown"` but must not treat it as "turned off": only a successful read of a closed gate revokes an opt-in.
 */
export function createShellEpochCache(settings: GateSettings): ShellEpochCache {
  let gate: ShellGate = "unknown";
  const stopWatching = settings.subscribe((state) => { gate = state.status === "ready" ? shellGateEpoch(state.values) : "unknown"; });
  return {
    async read() {
      try {
        const state = await settings.read();
        if (state.status === "invalid") throw new Error(state.error);
        gate = shellGateEpoch(state.values);
        return gate;
      } catch (error) {
        gate = "unknown";
        throw error;
      }
    },
    now: () => gate,
    stop: () => { stopWatching(); },
  };
}
