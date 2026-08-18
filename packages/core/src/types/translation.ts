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

/** AI 模型选择（端点 + 模型），翻译面板两个子栏各自独立配置 */
export interface AIModelSelection {
  endpointId?: string;
  model?: string;
}

/** 长按翻译的查词方案：AI 查词 / 本地 ECDICT 词典 */
export type DictionaryMethod = "ai" | "ecdict";

export interface TranslationConfig {
  provider: TranslationProvider;
  targetLang: TranslationTargetLang;
  /** 词典查词（长按单词）提示词模板；留空/未设置时使用内置 DEFAULT_DICTIONARY_PROMPT */
  dictionaryPrompt?: string;
  /** 取词翻译（选词翻译 / 整章翻译）使用的 AI 模型。未设置时使用对应功能直接报错，不跟随全局。 */
  selectionModel?: AIModelSelection;
  /** 长按翻译（词典查词）使用的 AI 模型。未设置时使用对应功能直接报错。 */
  dictionaryModel?: AIModelSelection;
  /** 长按翻译的查词方案；默认 AI 查词 */
  dictionaryMethod?: DictionaryMethod;
  /** 长按查词时自动朗读单词发音（TTS） */
  dictionarySpeak?: boolean;
  /** 非 AI 查词方案（ECDICT）无效时用 AI 查词兜底；默认开启 */
  dictionaryFallback?: boolean;
  /** 翻译弹窗拉伸后的尺寸（按模式独立记忆，下次打开沿用） */
  popoverSize?: {
    selection?: { width: number; height: number };
    dictionary?: { width: number; height: number };
  };
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
