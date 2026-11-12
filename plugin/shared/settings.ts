import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped plugin settings, shared by the server (registerSettings) and the client (useSettings).
 * The id and the v1 fields predate P3.7; `enableOmp` was added with a default, so stored v1 values
 * still parse and no migration is needed.
 */
export const herdrSettings = defineSettings({
  id: "herdr-connection",
  scope: "host",
  version: 1,
  schema: z.object({
    herdrSocketPath: z.string().default(""),
    herdrSession: z.string().default(""),
    /** Off: no new OMP discovery, import or launch. Open chats stay observable and can finish or stop. */
    enableOmp: z.boolean().default(true),
    /**
     * Global gate for shell input (default off). Off: every binding is treated as flag-off, persisted ones included, and an
     * open shell conversation freezes. The plugin's own RPCs and bind option never write it; Paseo's generic settings API can,
     * so it guards against accidental opt-in, not against a hostile Paseo client. A setting that cannot be read right now is
     * not "off": input is refused and no opt-in is forgotten.
     */
    allowShell: z.boolean().default(false),
    /**
     * Enable epoch (ms timestamp), stored by the settings UI in the same save as every move of the `allowShell` switch, on or
     * off, so each move stores an epoch no binding holds. A binding records the epoch it opted in under and counts only while
     * the setting still holds it: a chat that opted in before the setting was turned off stays disarmed when it is turned on
     * again, also by a write that only flips `allowShell` back to true (that keeps the off-save's fresh epoch). 0 (never set,
     * or an `allowShell` written without the UI switch) keeps the gate closed.
     */
    allowShellEpoch: z.number().int().nonnegative().default(0),
  }),
});

/** The enable epoch while the shell gate is open (setting on with a nonzero epoch), else null. On with epoch 0 is closed: the UI switch did not write it. */
export function shellGateEpoch(values: { allowShell: boolean; allowShellEpoch: number }): number | null {
  return values.allowShell && values.allowShellEpoch > 0 ? values.allowShellEpoch : null;
}

/** The shell gate as last read: an open epoch, `null` (read, and closed), or `"unknown"` (not read yet, or the read failed). */
export type ShellGate = number | null | "unknown";

/**
 * How the Herdr screen orders its agents. Host-scoped (the SDK has no per-device store), so every device that opens this
 * host shares one choice. `field` is validated by the client against its sort list, so an unknown value falls back to Herdr order.
 */
export const herdrViewSettings = defineSettings({
  id: "herdr-overview-view",
  scope: "host",
  version: 1,
  schema: z.object({
    field: z.string().default("herdr"),
    dir: z.enum(["asc", "desc"]).nullable().default(null),
    grouped: z.boolean().default(true),
  }),
});
