/**
 * Translation model selection resolution.
 *
 * The translation panel manages two independent AI model choices (selection
 * translation and long-press dictionary lookup). Both are required before the
 * corresponding feature can run — there is no fallback to the global active
 * model, per product decision.
 */

import type { AIConfig, AIEndpoint } from "../types";
import { providerRequiresApiKey } from "../utils";
import type { AIModelSelection } from "../types/translation";

export type TranslationModelMode = "selection" | "dictionary";

export const TRANSLATION_MODEL_UNSET_MESSAGE: Record<TranslationModelMode, string> = {
  selection: "未选择 AI 翻译模型。请在 设置 → 翻译 → 取词翻译 中选择一个 AI 模型。",
  dictionary: "未选择 AI 翻译模型。请在 设置 → 翻译 → 长按查词 中选择一个 AI 模型。",
};

/**
 * Resolve the endpoint + model for a translation mode from the user's choice.
 * Throws with a clear Chinese message when the selection is missing or invalid.
 */
export function resolveTranslationModel(
  aiConfig: AIConfig,
  selection: AIModelSelection | undefined,
  mode: TranslationModelMode,
): { endpoint: AIEndpoint; model: string } {
  if (!selection?.endpointId || !selection?.model) {
    throw new Error(TRANSLATION_MODEL_UNSET_MESSAGE[mode]);
  }
  const endpoint = aiConfig.endpoints.find((e) => e.id === selection.endpointId);
  if (!endpoint) {
    throw new Error("所选 AI 端点不存在或已被删除。请在 设置 → 翻译 中重新选择模型。");
  }
  if (providerRequiresApiKey(endpoint.provider) && !endpoint.apiKey) {
    throw new Error(`API key not set for endpoint "${endpoint.name}".`);
  }
  return { endpoint, model: selection.model };
}
