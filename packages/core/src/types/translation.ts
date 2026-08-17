/**
 * Translation Types
 */

export type TranslatorName = "ai" | "deepl" | "microsoft";

export interface TranslationProvider {
  id: TranslatorName;
  name: string;
  apiKey?: string;
  baseUrl?: string;
  useExactRequestUrl?: boolean;
  model?: string;
  endpointId?: string; // For AI translation, which endpoint to use
}

export type TranslationTargetLang =
  | "zh-CN"
  | "zh-TW"
  | "ja"
  | "ko"
  | "en"
  | "fr"
  | "de"
  | "es"
  | "pt"
  | "it"
  | "ru"
  | "ar"
  | "th"
  | "vi"
  | "id"
  | "tr"
  | "pl"
  | "nl"
  | "sv"
  | "ug";

export interface TranslationConfig {
  provider: TranslationProvider;
  targetLang: TranslationTargetLang;
  /** 词典查词（长按单词）提示词模板；留空/未设置时使用内置 DEFAULT_DICTIONARY_PROMPT */
  dictionaryPrompt?: string;
}

export const TRANSLATOR_PROVIDERS: Array<{ id: TranslatorName; labelKey: string }> = [
  { id: "microsoft", labelKey: "translation.providerMicrosoft" },
  { id: "ai", labelKey: "translation.providerAI" },
  { id: "deepl", labelKey: "translation.providerDeepL" },
];

export const TRANSLATOR_LANGS: Record<TranslationTargetLang, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語",
  ko: "한국어",
  en: "English",
  fr: "Français",
  de: "Deutsch",
  es: "Español",
  pt: "Português",
  it: "Italiano",
  ru: "Русский",
  ar: "العربية",
  th: "ไทย",
  vi: "Tiếng Việt",
  id: "Bahasa Indonesia",
  tr: "Türkçe",
  pl: "Polski",
  nl: "Nederlands",
  sv: "Svenska",
  ug: "ئۇيغۇرچە",
};
