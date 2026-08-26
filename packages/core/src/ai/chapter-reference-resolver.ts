export interface ChapterReferenceEntry {
  chapterIndex: number;
  chapterTitle: string;
  preview?: string;
}

export interface ChapterReferenceCandidate {
  chapterIndex: number;
  chapterTitle: string;
  detectedChapterNumber?: number;
  confidence: number;
  matchType: "number" | "title" | "mixed" | "weak";
  reason: string;
}

export interface ChapterReferenceResult {
  matched: boolean;
  confidence: number;
  matchType: "number" | "title" | "mixed" | "weak" | "none";
  chapterIndex?: number;
  chapterTitle?: string;
  detectedChapterNumber?: number;
  candidates: ChapterReferenceCandidate[];
  reason: string;
}

const CHINESE_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const CHAPTER_TITLE_RE =
  /第\s*([零〇一二两三四五六七八九十百千万\d]+)\s*[章卷节回讲篇话]\s*([^\n\r]{0,40})/u;

const QUERY_CHAPTER_RE =
  /(?:第\s*)?([零〇一二两三四五六七八九十百千万\d]{1,8})\s*(?:章|卷|节|回|讲|篇|话)/u;

/** "4. Launch" / "4 Launch" / "4、标题" — number-prefixed chapter titles (common in EPUB TOCs). */
const NUMBER_PREFIX_TITLE_RE = /^\s*(\d{1,4})\s*[.、．:：)）]?\s+(?=\S)/u;

/** "Chapter 9" / "CHAPTER 09" — common in EPUB TOCs (Dune, 1984, etc.). */
const CHAPTER_PREFIX_TITLE_RE = /^\s*chapter\s+(\d{1,4})\b/i;

function parseChineseNumber(input: string): number | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!/[十百千万零〇一二两三四五六七八九]/u.test(raw)) return null;

  let result = 0;
  let section = 0;
  let number = 0;
  const unitMap: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

  for (const char of raw) {
    if (char === "万") {
      section = (section + number) || 1;
      result += section * 10000;
      section = 0;
      number = 0;
      continue;
    }

    const unit = unitMap[char];
    if (unit) {
      section += (number || 1) * unit;
      number = 0;
      continue;
    }

    if (char in CHINESE_DIGITS) {
      number = CHINESE_DIGITS[char]!;
    }
  }

  return result + section + number;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/section\s*\d+/gi, "")
    .replace(/[第章卷节回讲篇话]/gu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function getLeadingTitle(value = ""): string {
  const firstLines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
  return firstLines.find((line) => CHAPTER_TITLE_RE.test(line)) || firstLines[0] || "";
}

function extractChapterNumber(value: string): number | undefined {
  // "第N章" pattern first (Chinese books, "3. Red Coast I" style).
  const match = value.match(CHAPTER_TITLE_RE);
  if (match?.[1]) return parseChineseNumber(match[1]) ?? undefined;
  // "Chapter 9" / "CHAPTER 09" (Dune, 1984-style TOCs).
  const chapterPrefixMatch = value.match(CHAPTER_PREFIX_TITLE_RE);
  if (chapterPrefixMatch?.[1]) return Number(chapterPrefixMatch[1]);
  // "4. Launch" / "4 Launch" prefix pattern (EPUB TOCs).
  const prefixMatch = value.match(NUMBER_PREFIX_TITLE_RE);
  if (prefixMatch?.[1]) return Number(prefixMatch[1]);
  return undefined;
}

function extractQueryChapterNumber(query: string): number | undefined {
  const sanitizedQuery = query.replace(
    /(?:这|那|哪)\s*一\s*(?:章|卷|节|回|讲|篇|话)/gu,
    " ",
  );
  const match = sanitizedQuery.match(QUERY_CHAPTER_RE);
  if (!match?.[1]) return undefined;
  return parseChineseNumber(match[1]) ?? undefined;
}

function levenshteinRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous.splice(0, previous.length, ...current);
  }

  const distance = previous[b.length] ?? Math.max(a.length, b.length);
  return 1 - distance / Math.max(a.length, b.length);
}

function titleScore(query: string, title: string): number {
  const normalizedQuery = normalizeText(query);
  const normalizedTitle = normalizeText(title);
  if (!normalizedQuery || !normalizedTitle) return 0;

  if (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle)) {
    return Math.min(1, Math.min(normalizedQuery.length, normalizedTitle.length) / 4);
  }

  const compactQuery = normalizedQuery.replace(/\d+/g, "");
  const compactTitle = normalizedTitle.replace(/\d+/g, "");
  if (!compactQuery || !compactTitle) return 0;

  if (
    compactTitle.length >= 2 &&
    (compactQuery.includes(compactTitle) || compactTitle.includes(compactQuery))
  ) {
    return 0.95;
  }

  const overlapChars = new Set([...compactQuery].filter((char) => compactTitle.includes(char)));
  const overlap = overlapChars.size / Math.max(new Set(compactQuery).size, 1);
  return Math.max(overlap * 0.8, levenshteinRatio(compactQuery, compactTitle));
}

function buildDisplayTitle(entry: ChapterReferenceEntry): string {
  const leadingTitle = getLeadingTitle(entry.preview);
  const titleIsSynthetic = /^section\s+\d+$/i.test(entry.chapterTitle.trim());
  if (titleIsSynthetic && CHAPTER_TITLE_RE.test(leadingTitle)) return leadingTitle;
  return entry.chapterTitle || leadingTitle || `Chapter ${entry.chapterIndex}`;
}

export function resolveChapterReference(
  query: string,
  entries: ChapterReferenceEntry[],
  maxCandidates = 3,
): ChapterReferenceResult {
  const requestedNumber = extractQueryChapterNumber(query);
  const candidates = entries
    .map((entry): ChapterReferenceCandidate => {
      const displayTitle = buildDisplayTitle(entry);
      const leadingTitle = getLeadingTitle(entry.preview);
      const detectedChapterNumber =
        extractChapterNumber(displayTitle) ?? extractChapterNumber(leadingTitle);
      const numberMatched =
        requestedNumber !== undefined && detectedChapterNumber === requestedNumber;
      const titleSimilarity = titleScore(query, displayTitle);

      let confidence = 0;
      let matchType: ChapterReferenceCandidate["matchType"] = "weak";
      const reasons: string[] = [];

      if (numberMatched) {
        confidence += 0.82;
        matchType = "number";
        reasons.push(`chapter number ${requestedNumber} matched`);
      }

      if (titleSimilarity >= 0.45) {
        confidence += Math.min(0.86, titleSimilarity * 0.86);
        matchType = numberMatched ? "mixed" : "title";
        reasons.push(`title similarity ${titleSimilarity.toFixed(2)}`);
      }

      if (requestedNumber !== undefined && detectedChapterNumber === undefined) {
        confidence -= 0.15;
        reasons.push("no real chapter number found in title");
      }

      return {
        chapterIndex: entry.chapterIndex,
        chapterTitle: displayTitle,
        detectedChapterNumber,
        confidence: Math.max(0, Math.min(1, confidence)),
        matchType,
        reason: reasons.join("; ") || "weak textual similarity",
      };
    })
    .filter((candidate) => candidate.confidence > 0.05)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, Math.max(1, maxCandidates));

  const best = candidates[0];
  if (!best) {
    return {
      matched: false,
      confidence: 0,
      matchType: "none",
      candidates: [],
      reason: requestedNumber
        ? `No chapter matched requested chapter number ${requestedNumber}`
        : "No reliable chapter reference found",
    };
  }

  const second = candidates[1];
  const hasClearLead = !second || best.confidence - second.confidence >= 0.12;
  const matched = best.confidence >= 0.72 && hasClearLead;

  return {
    matched,
    confidence: best.confidence,
    matchType: matched ? best.matchType : "weak",
    chapterIndex: matched ? best.chapterIndex : undefined,
    chapterTitle: matched ? best.chapterTitle : undefined,
    detectedChapterNumber: matched ? best.detectedChapterNumber : undefined,
    candidates,
    reason: matched
      ? best.reason
      : "Chapter reference is ambiguous or below confidence threshold",
  };
}
