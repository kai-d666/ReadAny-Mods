/**
 * Eudic web dictionary lookup (dict.eudic.net).
 * Fetches the server-rendered entry page and extracts the definition via
 * DOMParser. Parsing is concentrated here so page-structure changes are
 * easy to fix in one place.
 */

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export interface EudicEntry {
  phonetic?: string;
  senses: string[];
  examples: string[];
}

const EUDIC_URL = "https://dict.eudic.net/dicts/en/";
const EUDIC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export async function fetchEudicEntry(word: string): Promise<string> {
  const url = `${EUDIC_URL}${encodeURIComponent(word)}`;
  const res = await tauriFetch(url, {
    headers: {
      "User-Agent": EUDIC_UA,
      Accept: "text/html",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.text();
}

const POS_TOKEN = "(?:n|v|adj|adv|vt|vi|prep|conj|pron|num|art|int|aux|mod|det)\\.";
// Part-of-speech tags may repeat (e.g. "adj., pron."); the sense text follows.
const POS_SENSE_RE = new RegExp(
  `>((?:${POS_TOKEN}\\s*,?\\s*){1,3}[^<>]{2,150})<`,
  "g",
);

export function parseEudicEntry(html: string): EudicEntry {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const entry: EudicEntry = { senses: [], examples: [] };

  // Phonetic block like 英/θɔːt/美/θɔːt/
  const info = doc.querySelector(".explain-word-info");
  const infoText = info?.textContent ?? "";
  const phMatch = infoText.match(/(?:英|美)\/[^/]+\/(?:\s*(?:英|美)\/[^/]+\/)?/);
  if (phMatch) {
    entry.phonetic = phMatch[0].replace(/\s+/g, " ").trim();
  }

  // Senses: Eudic uses several templates (ol/li, div/p, …) so instead of DOM
  // selectors we scan raw text nodes between tags and keep every line that
  // starts with a part-of-speech tag. Inline tags (<img>, <i>, <span>…) would
  // split a line, so strip them first (keep their text).
  const cleanHtml = html
    .replace(/<img[^>]*>/g, "")
    .replace(/<\/(?:i|b|span|em|strong|u|s|font)>/g, "")
    .replace(/<(?:i|b|span|em|strong|u|s|font)[^>]*>/g, "");
  let m: RegExpExecArray | null;
  while ((m = POS_SENSE_RE.exec(cleanHtml))) {
    const text = m[1].replace(/\s+/g, " ").trim();
    if (text && !entry.senses.includes(text)) {
      entry.senses.push(text);
    }
  }

  return entry;
}
