/**
 * Session-level token totals for the assistant footer (`+546/9,764sum`).
 *
 * Cost semantics: each turn's `totalTokens` already includes the whole context
 * that call had to re-send, so summing turns answers "how many tokens did this
 * conversation burn" — NOT "how big is this conversation". That is intended,
 * and it matches the KOReader plugin's third layer.
 *
 * Lives in core rather than app-expo because core is the package with a test
 * runner.
 */

export interface TokenLedgerMessage {
  role: string;
  totalTokens?: number;
}

/**
 * Prefix sums over `messages`: result[i] = Σ totalTokens of assistant messages
 * up to and including i. Non-assistant roles are never counted, even if they
 * somehow carry the field.
 */
export function computeSessionTokenTotals(messages: TokenLedgerMessage[]): number[] {
  let running = 0;
  return messages.map((message) => {
    if (message.role === "assistant") running += message.totalTokens ?? 0;
    return running;
  });
}

/** 1234567 → "1,234,567" */
export function formatTokenCount(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "+546/9,764sum" — this turn / running session total. */
export function formatTurnAndSessionTokens(turn: number, session: number): string {
  return `+${formatTokenCount(turn)}/${formatTokenCount(session)}sum`;
}
