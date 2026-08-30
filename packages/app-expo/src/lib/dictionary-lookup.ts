/**
 * dictionary-lookup — 内置翻译查词(按翻译引擎分流)。
 *
 * 与词典接口表(dictionary-intents)相对:
 * - provider = "external" → 长按查词拉起第三方词典(launchDictionary)
 * - provider = ai / deepl / microsoft → 走内置翻译引擎查词,本文件负责组装请求并返回结果文本:
 *   - ai → 词典式释义(buildDictionaryPrompt + aiTranslate,支持自定义 dictionaryPrompt)
 *   - microsoft / deepl → 单词翻译(纯翻译服务无释义能力,按引擎直译)
 */
import type { AIConfig } from "@readany/core/types/chat";
import type { TranslationConfig } from "@readany/core/types/translation";
import {
  aiTranslate,
  buildDictionaryPrompt,
  deeplTranslate,
  microsoftTranslate,
} from "@readany/core/translation/providers";

/** 内置翻译引擎未配置(如 AI 无端点/模型)时抛出,调用方提示去 AI 设置 */
export class LookupProviderNotConfiguredError extends Error {
  constructor() {
    super("built-in lookup provider not configured");
    this.name = "LookupProviderNotConfiguredError";
  }
}

/** 内置翻译查词:按翻译引擎分派,返回一次查词结果文本(词典释义/单词翻译)。 */
export async function lookupWithProvider(
  word: string,
  translationConfig: TranslationConfig,
  aiConfig: AIConfig,
): Promise<string> {
  const trimmed = (word || "").trim();
  const targetLang = translationConfig.targetLang;

  if (translationConfig.provider.id === "ai") {
    // 端点解析与整章翻译同逻辑:endpointId 优先,否则 activeEndpointId
    const endpointId = translationConfig.provider.endpointId || aiConfig.activeEndpointId;
    const endpoint = aiConfig.endpoints.find((e) => e.id === endpointId);
    if (!endpoint) throw new LookupProviderNotConfiguredError();
    const model = translationConfig.provider.model || aiConfig.activeModel;
    if (!model) throw new LookupProviderNotConfiguredError();
    const prompt = buildDictionaryPrompt(
      translationConfig.dictionaryPrompt,
      "AUTO",
      targetLang,
      trimmed,
    );
    const results = await aiTranslate(
      [trimmed],
      "AUTO",
      targetLang,
      endpoint.apiKey,
      endpoint.baseUrl,
      model,
      endpoint.useExactRequestUrl || false,
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
