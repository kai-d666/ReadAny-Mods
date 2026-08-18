/**
 * useTranslator Hook
 * React hook for translation with caching
 * Uses AI config for translation (model, apiKey, baseUrl)
 */

import { useCallback, useState } from "react";
import { useSettingsStore } from "../stores/settings-store";
import { clearTranslationCacheFor, getFromCache, simpleHash, storeInCache } from "../translation/cache";
import {
  resolveTranslationModel,
  type TranslationModelMode,
} from "../translation/model-selection";
import { aiTranslate, deeplTranslate, microsoftTranslate } from "../translation/providers";
import type { AIConfig } from "../types";
import type { TranslationConfig, TranslationTargetLang } from "../types/translation";
import { providerRequiresApiKey } from "../utils";

export interface UseTranslatorOptions {
  sourceLang?: string;
  targetLang?: TranslationTargetLang;
  aiConfig?: AIConfig;
  translationConfig?: TranslationConfig;
  /** 自定义 AI 系统提示词（如词典模式）；仅 ai provider 生效，缺省走默认翻译提示词 */
  systemPrompt?: string;
  /**
   * Translation mode for model resolution. When set, the corresponding
   * translationConfig.selectionModel/dictionaryModel is required (no global
   * fallback, errors when unset). When omitted, the legacy resolution
   * (provider.endpointId/model || aiConfig.active*) is used.
   */
  mode?: TranslationModelMode;
}

export function useTranslator(options: UseTranslatorOptions = {}) {
  const {
    sourceLang = "AUTO",
    targetLang,
    aiConfig: aiConfigOverride,
    translationConfig: translationConfigOverride,
    systemPrompt,
    mode,
  } = options;
  const translationConfigFromStore = useSettingsStore((s) => s.translationConfig);
  const aiConfigFromStore = useSettingsStore((s) => s.aiConfig);
  const translationConfig = translationConfigOverride || translationConfigFromStore;
  const aiConfig = aiConfigOverride || aiConfigFromStore;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const translate = useCallback(
    async (texts: string[]): Promise<string[]> => {
      const textsToTranslate = texts.map((t) => t.trim()).filter((t) => t);
      if (textsToTranslate.length === 0) {
        return texts;
      }

      const targetLanguage = targetLang || translationConfig.targetLang;
      const providerId = translationConfig.provider.id;
      // Isolate cache entries by prompt mode so dictionary results never collide
      // with plain translations; the prompt fingerprint makes edited prompts
      // bypass stale cached results immediately.
      const cacheMode = systemPrompt ? `dict_${simpleHash(systemPrompt)}` : "default";

      const cachedResults: string[] = [];
      const needsTranslation: { index: number; text: string }[] = [];
      await Promise.all(
        textsToTranslate.map(async (text, index) => {
          const cached = await getFromCache(text, sourceLang, targetLanguage, providerId, cacheMode);
          if (cached) {
            cachedResults[index] = cached;
          } else {
            needsTranslation.push({ index, text });
          }
        }),
      );

      if (needsTranslation.length === 0) {
        return textsToTranslate.map((_, i) => cachedResults[i] || "");
      }

      setLoading(true);
      setError(null);

      try {
        let translatedTexts: string[];

        if (providerId === "ai") {
          let endpoint: AIConfig["endpoints"][number] | undefined;
          let model: string;

          if (mode) {
            // Explicit per-mode selection (no global fallback)
            const resolved = resolveTranslationModel(
              aiConfig,
              mode === "dictionary"
                ? translationConfig.dictionaryModel
                : translationConfig.selectionModel,
              mode,
            );
            endpoint = resolved.endpoint;
            model = resolved.model;
          } else {
            // Legacy resolution (kept for app-expo compatibility)
            const endpointId = translationConfig.provider.endpointId || aiConfig.activeEndpointId;
            endpoint = aiConfig.endpoints.find((e) => e.id === endpointId);
            model = translationConfig.provider.model || aiConfig.activeModel;

            if (!endpoint || (providerRequiresApiKey(endpoint.provider) && !endpoint.apiKey)) {
              throw new Error("AI endpoint not configured. Please set up AI settings first.");
            }
          }

          const dictionaryTuned =
            mode === "dictionary"
              ? {
                  temperature: 0.2,
                  topP: 0.8,
                  repetitionPenalty: 1.1,
                  maxTokens: 200,
                }
              : {};
          translatedTexts = await aiTranslate(
            needsTranslation.map((n) => n.text),
            sourceLang,
            targetLanguage,
            endpoint.apiKey,
            endpoint.baseUrl,
            model,
            endpoint.useExactRequestUrl || false,
            {
              systemPrompt,
              ...dictionaryTuned,
            },
          );
        } else if (providerId === "deepl") {
          const apiKey = translationConfig.provider.apiKey;
          if (!apiKey) {
            throw new Error("DeepL API key is required");
          }
          translatedTexts = await deeplTranslate(
            needsTranslation.map((n) => n.text),
            sourceLang,
            targetLanguage,
            apiKey,
            translationConfig.provider.baseUrl,
          );
        } else if (providerId === "microsoft") {
          translatedTexts = await microsoftTranslate(
            needsTranslation.map((n) => n.text),
            sourceLang,
            targetLanguage,
          );
        } else {
          throw new Error(`Unknown translation provider: ${providerId}`);
        }

        await Promise.all(
          needsTranslation.map(async ({ text }, i) => {
            if (translatedTexts[i]) {
              await storeInCache(
                text,
                translatedTexts[i],
                sourceLang,
                targetLanguage,
                providerId,
                cacheMode,
              );
            }
          }),
        );

        const results = [...textsToTranslate];
        cachedResults.forEach((cached, i) => {
          if (cached) results[i] = cached;
        });
        needsTranslation.forEach(({ index }, i) => {
          results[index] = translatedTexts[i] || "";
        });

        setLoading(false);
        return results;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(errorMessage);
        setLoading(false);
        throw err;
      }
    },
    [sourceLang, targetLang, translationConfig, aiConfig, systemPrompt, mode],
  );

  // Clear the cache entry for one text (same mode/key space as translate)
  const clearCache = useCallback(
    (t: string) => {
      const input = t.trim();
      if (!input) return Promise.resolve();
      const cacheMode = systemPrompt ? `dict_${simpleHash(systemPrompt)}` : "default";
      return clearTranslationCacheFor(
        input,
        sourceLang,
        targetLang || translationConfig.targetLang,
        translationConfig.provider.id,
        cacheMode,
      );
    },
    [systemPrompt, sourceLang, targetLang, translationConfig],
  );

  return {
    translate,
    clearCache,
    loading,
    error,
    provider: translationConfig.provider.id,
    targetLang: translationConfig.targetLang,
  };
}
