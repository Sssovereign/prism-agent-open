// Submission identities survive transport ambiguity; settlement never consumes a newer draft.
export interface DraftSnapshot { scope: string; revision: number; text: string }
export interface SubmissionClaim extends DraftSnapshot { clientMessageId: string }
export class ComposerSubmissionLedger {
  private pending = new Map<string, SubmissionClaim>();
  constructor(private readonly makeId: () => string = () => crypto.randomUUID()) {}
  claim(snapshot: DraftSnapshot): SubmissionClaim {
    const previous = this.pending.get(snapshot.scope);
    if (previous && previous.revision === snapshot.revision && previous.text === snapshot.text) return previous;
    const claim = { ...snapshot, clientMessageId: this.makeId() };
    this.pending.set(snapshot.scope, claim);
    return claim;
  }
  settle(claim: SubmissionClaim, current: DraftSnapshot): boolean {
    if (this.pending.get(claim.scope)?.clientMessageId === claim.clientMessageId) this.pending.delete(claim.scope);
    return claim.scope === current.scope && claim.revision === current.revision && claim.text === current.text;
  }
  clear(): void { this.pending.clear(); }
}
