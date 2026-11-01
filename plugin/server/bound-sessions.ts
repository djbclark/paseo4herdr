import type { HerdrHarnessSession } from "./session.js";

/** Open sessions created by binding an existing agent, by (Herdr session, terminal id); lets management RPCs reach them. */
export class BoundSessions {
  private readonly sessions = new Set<HerdrHarnessSession>();
  add(session: HerdrHarnessSession): void { this.sessions.add(session); }
  delete(session: HerdrHarnessSession): void { this.sessions.delete(session); }
  /** Send any held history for chats bound to this agent (`herdr.chat.ready`). */
  flushHistory(herdrSession: string | null, terminalId: string): number {
    let flushed = 0;
    for (const session of this.sessions) {
      if (session.isAborted) {
        this.delete(session);
        continue;
      }
      const { binding } = session.state;
      if (binding.herdrSession === herdrSession && binding.terminalId === terminalId) {
        session.flushHistory();
        flushed++;
      }
    }
    return flushed;
  }
}

/** Every open session, so a management RPC can reach a live conversation by its Paseo agent id (`herdr.chat.allow-shell`). */
export class OpenSessions {
  private readonly sessions = new Set<HerdrHarnessSession>();
  /**
   * Paseo agents whose shell input was turned off while their conversation was closed. Paseo owns the stored persistence
   * and the plugin has no write access to it, so the next open clears the flag instead. In memory only: the plugin
   * setting is the durable global switch.
   */
  private readonly revoked = new Set<string>();
  revokeShell(agentId: string): void { this.revoked.add(agentId); }
  clearRevoked(agentId: string): void { this.revoked.delete(agentId); }
  isRevoked(agentId: string): boolean { return this.revoked.has(agentId); }
  add(session: HerdrHarnessSession): void { this.sessions.add(session); }
  delete(session: HerdrHarnessSession): void { this.sessions.delete(session); }
  /** The open, not yet closed sessions of Paseo agent `agentId` (a reopened chat may briefly have two). */
  byAgentId(agentId: string): HerdrHarnessSession[] {
    return [...this.sessions].filter((session) => !session.isAborted && session.paseoAgentId === agentId);
  }
}
