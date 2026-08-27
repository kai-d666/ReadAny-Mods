/**
 * Language hint appended to retrieval-tool descriptions: guides query
 * construction toward the book's language when user and book languages differ
 * (e.g. Chinese question + English book — proper nouns must be English terms).
 * Empty/undefined language → empty hint (no injection, zero extra tokens).
 */
export function bookLanguageHint(language?: string): string {
  if (!language?.trim()) return "";
  return ` Book language: ${language} — if the user's question language differs from the book's, construct the query using ${language} terms for proper nouns and key concepts, while keeping the user's language for question intent.`;
}
