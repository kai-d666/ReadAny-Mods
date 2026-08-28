/**
 * Quote-context prefetch — A-plan injection (三模式-选项决策.md / 注入总表):
 * when the user sends a quote with a CFI, fetch the text around that anchor
 * (before/after, bounded by the reader session) and inject it into the turn's
 * user message, so the model can answer about the quote without a tool
 * round-trip. This is the only raw-text entry in Knowledge-Only mode.
 *
 * Fail-open: no CFI / no provider / timeout / error → empty section → the
 * turn behaves exactly as before (quote text alone).
 */
import type { AttachedQuote } from "../types";
import { getBookContentSearchProvider } from "./fallback-content-service";

/** Race threshold mirroring getSurroundingContext (context-tools.ts). */
const CONTEXT_TIMEOUT_MS = 3500;
const MAX_CONTEXT_CHARS = 6000;

/** Prefetch & format the context section for one quote. Empty = skip. */
async function fetchQuoteContext(bookId: string, quote: AttachedQuote): Promise<string> {
  if (!quote.cfi) return "";
  try {
    const provider = getBookContentSearchProvider();
    if (!provider || typeof provider.getContextAroundCfi !== "function") return "";
    const result = await Promise.race([
      provider.getContextAroundCfi(bookId, quote.cfi),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CONTEXT_TIMEOUT_MS)),
    ]);
    if (!result) return "";
    const text = [result.before, result.after].filter(Boolean).join("\n...\n");
    if (!text) return "";
    // Framed as system-provided background — the model must treat it as
    // reference only, never recap/explain the material (or its location
    // metadata) to the user.
    return (
      "\n\n【背景材料 · 引文附近的原文内容】\n" +
      `${text.slice(0, MAX_CONTEXT_CHARS)}\n` +
      "【背景材料完 · 以上由系统提供,回答时仅作参考依据;不要复述、解释这段材料或它的格式、位置标识】"
    );
  } catch {
    return "";
  }
}

/**
 * Build the quote-context sections for all quotes with a CFI (prefetched in
 * parallel, joined in quote order). Empty string = nothing to inject.
 */
export async function buildQuoteContextSection(
  bookId: string,
  quotes: AttachedQuote[],
): Promise<string> {
  if (!bookId || !quotes?.length) return "";
  const sections = await Promise.all(quotes.map((q) => fetchQuoteContext(bookId, q)));
  return sections.filter(Boolean).join("\n");
}
