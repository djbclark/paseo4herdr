import { describe, expect, it } from "vitest";
import { herdrSettings, shellGateEpoch } from "../shared/settings.js";

describe("shell gate epoch", () => {
  it("is open only while the setting is on with a nonzero epoch", () => {
    expect(shellGateEpoch({ allowShell: true, allowShellEpoch: 1700 })).toBe(1700);
    expect(shellGateEpoch({ allowShell: false, allowShellEpoch: 1700 })).toBeNull();
    expect(shellGateEpoch({ allowShell: true, allowShellEpoch: 0 })).toBeNull(); // on without the UI switch's epoch
  });

  it("a settings document stored before epochs parses with the gate closed", () => {
    const stored = herdrSettings.schema.parse({ herdrSocketPath: "", herdrSession: "", enableOmp: true, allowShell: true });
    expect(stored.allowShellEpoch).toBe(0);
    expect(shellGateEpoch(stored)).toBeNull();
  });
});
