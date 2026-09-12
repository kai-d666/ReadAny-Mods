/**
 * 书源简介的 HTML → 纯文本(2026-09-12)
 *
 * 背景:Z-Library 的 `description` 本身是 HTML(`<p>…</p><p>…</p>`),
 * 直接渲染会让用户看到满屏 `<p>` 标签(手机详情页实测);外部 OPDS / LibGen 也会夹标签。
 *
 * 与 `driver/libgen.ts` 里私有的 `stripTags` 的区别:那个把全文压成单行(适合短字段),
 * 这个**保留段落结构**(块级标签转换行),适合简介这种多段文本。
 */

/** 块级边界 → 换行:闭合的块元素 + <br>/<hr>(保留段落感) */
const BLOCK_BOUNDARY =
  /<\s*(?:\/\s*(?:p|div|li|ul|ol|h[1-6]|blockquote|tr|td|section|article|figure)\s*|br\s*\/?|hr\s*\/?)\s*>/gi;
/** 任意标签(含属性) */
const ANY_TAG = /<[^>]*>/g;
/** 判断"像不像 HTML":用非全局正则 test,避免 lastIndex 串味 */
const LOOKS_LIKE_HTML = /<[a-z/][^>]*>/i;
const LOOKS_LIKE_ENTITY = /&(?:[a-z][a-z0-9]{1,8}|#\d{1,7}|#x[0-9a-f]{1,6});/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
};

function decodeCodePoint(match: string, value: string, radix: number): string {
  const code = Number.parseInt(value, radix);
  // 越界码点会让 String.fromCodePoint 抛错;非法就原样保留
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
  try {
    return String.fromCodePoint(code);
  } catch {
    return match;
  }
}

/**
 * 把（可能带 HTML 的）简介转成纯文本:块级标签保留段落、剥标签、解实体、收敛空白。
 * 纯文本输入原样（仅去首尾空白 + 解实体）返回,不会误伤含 `<`/`>` 的正常文字。
 */
export function htmlToPlainText(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const source = raw.replace(/\r\n?/g, "\n");
  const looksLikeHtml =
    LOOKS_LIKE_HTML.test(source) || LOOKS_LIKE_ENTITY.test(source);

  let text = source;
  if (looksLikeHtml) {
    text = text.replace(BLOCK_BOUNDARY, "\n").replace(ANY_TAG, "");
  }
  text = text
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, hex: string) => decodeCodePoint(m, hex, 16))
    .replace(/&#(\d{1,7});/g, (m, dec: string) => decodeCodePoint(m, dec, 10))
    .replace(/&([a-z][a-z0-9]{1,8});/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, "\n") // 行尾空白
    .replace(/[ \t]{2,}/g, " ") // 连续空白
    .replace(/\n{3,}/g, "\n\n") // 空行最多保留一个
    .trim();

  return text || undefined;
}
