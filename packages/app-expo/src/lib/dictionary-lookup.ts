/**
 * dictionary-lookup — 内置翻译/查词(按翻译引擎与模式分流)。
 *
 * 与词典接口表(dictionary-intents)相对:
 * - provider = "external" → 长按查词拉起第三方词典(launchDictionary)
 * - provider = ai / deepl / microsoft → 走内置翻译引擎,本文件组装请求并返回结果文本:
 *   - mode="dictionary"(长按查词):AI → 词典式释义(buildDictionaryPrompt + aiTranslate,
 *     **强制 dictionaryModel**,未配置抛中文指引);ECDICT 查词方案 → 本地词典(stub 未集成)
 *     按「AI 兜底」开关走 AI;微软/DeepL → 直译单词
 *   - mode="selection"(取词翻译):AI → 标准翻译提示词 + **强制 selectionModel**;微软/DeepL → 直译
 */
import { resolveTranslationModel } from "@readany/core/translation/model-selection";
import type { AIConfig } from "@readany/core/types/chat";
import type { TranslationConfig } from "@readany/core/types/translation";
import {
  aiTranslate,
  buildDictionaryPrompt,
  deeplTranslate,
  microsoftTranslate,
} from "@readany/core/translation/providers";
import { lookupLocalDictionary } from "./ecdict-lookup";

export type BuiltinLookupMode = "selection" | "dictionary";

/** 内置翻译引擎未配置(如 AI 无端点/模型)时由 resolveTranslationModel 抛中文指引,调用方原样展示 */
export async function translateBuiltin(
  text: string,
  translationConfig: TranslationConfig,
  aiConfig: AIConfig,
  mode: BuiltinLookupMode = "dictionary",
): Promise<string> {
  const trimmed = (text || "").trim();
  const targetLang = translationConfig.targetLang;

  // ── ECDICT 查词方案(仅长按查词):本地词典 → 未命中按「AI 兜底」开关 ──────────────
  if (mode === "dictionary" && (translationConfig.dictionaryMethod ?? "ai") === "ecdict") {
    const entry = await lookupLocalDictionary(trimmed);
    if (entry) {
      return formatEcdictEntry(entry);
    }
    if (translationConfig.dictionaryFallback === false) {
      throw new Error("本地词典未命中，且已关闭 AI 兜底；请开启兜底或改用 AI 查词。");
    }
    // 兜底 → 落入下方 provider 分派(照常走 AI 查词)
  }

  // ── provider 分派 ────────────────────────────────────────────────────────────
  if (translationConfig.provider.id === "ai") {
    const resolved = resolveTranslationModel(
      aiConfig,
      mode === "dictionary" ? translationConfig.dictionaryModel : translationConfig.selectionModel,
      mode,
    );
    const prompt =
      mode === "dictionary"
        ? buildDictionaryPrompt(translationConfig.dictionaryPrompt, "AUTO", targetLang, trimmed)
        : undefined;
    const results = await aiTranslate(
      [trimmed],
      "AUTO",
      targetLang,
      resolved.endpoint.apiKey,
      resolved.endpoint.baseUrl,
      resolved.model,
      resolved.endpoint.useExactRequestUrl || false,
      { systemPrompt: prompt },
    );
    return results[0] || "";
  }

  if (translationConfig.provider.id === "microsoft") {
    const results = await microsoftTranslate([trimmed], "AUTO", targetLang);
    return results[0] || "";
  }

  // deepl(其余分支;chapter-translator 同款调用)
  const results = await deeplTranslate(
    [trimmed],
    "AUTO",
    targetLang,
    translationConfig.provider.apiKey || "",
    translationConfig.provider.baseUrl,
  );
  return results[0] || "";
}

/** ECDICT 命中时拼近似桌面板展示文本(移动端现阶段无命中,预留) */
function formatEcdictEntry(entry: { word: string; phonetic: string; translation: string }): string {
  const phonetic = entry.phonetic ? `/${entry.phonetic}/` : "";
  return `${entry.word} ${phonetic}\n${entry.translation}`;
}
