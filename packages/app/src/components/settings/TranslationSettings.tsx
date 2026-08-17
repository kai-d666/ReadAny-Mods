import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
/**
 * TranslationSettings — translation provider config
 * The engine (microsoft / ai / deepl) is shared; when AI is selected the
 * panel splits into two independent model choices:
 *   - 取词翻译 (selection translation / whole-chapter translation)
 *   - 长按翻译 (long-press dictionary lookup, with its own prompt)
 * Each requires its own model — no global fallback.
 */
import { Textarea } from "@/components/ui/textarea";
import { useSettingsStore } from "@/stores/settings-store";
import { TRANSLATOR_PROVIDERS } from "@readany/core/types/translation";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TranslationModelSelector } from "./TranslationModelSelector";

export function TranslationSettings() {
  const { t } = useTranslation();
  const { translationConfig, updateTranslationConfig } = useSettingsStore();

  const isAIProvider = translationConfig.provider.id === "ai";
  const isDeepLProvider = translationConfig.provider.id === "deepl";

  // Provider dropdown
  const [providerOpen, setProviderOpen] = useState(false);
  const providerPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!providerOpen) return;
    const handler = (e: MouseEvent) => {
      if (providerPopoverRef.current && !providerPopoverRef.current.contains(e.target as Node)) {
        setProviderOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [providerOpen]);

  const handleProviderChange = (providerId: string) => {
    updateTranslationConfig({
      provider: {
        ...translationConfig.provider,
        id: providerId as "ai" | "deepl" | "microsoft",
        name: TRANSLATOR_PROVIDERS.find((p) => p.id === providerId)?.labelKey || "",
      },
    });
  };

  const handleApiKeyChange = (apiKey: string) => {
    updateTranslationConfig({
      provider: {
        ...translationConfig.provider,
        apiKey,
      },
    });
  };

  const handleBaseUrlChange = (baseUrl: string) => {
    updateTranslationConfig({
      provider: {
        ...translationConfig.provider,
        baseUrl,
      },
    });
  };

  const currentProvider = TRANSLATOR_PROVIDERS.find((p) => p.id === translationConfig.provider.id);

  return (
    <div className="space-y-4 p-4 pt-3">
      <section className="rounded-lg bg-muted/60 p-4">
        <h2 className="mb-4 text-sm font-medium text-foreground">
          {t("settings.translation_title")}
        </h2>
        <p className="mb-4 text-xs text-muted-foreground">{t("settings.translation_desc")}</p>

        <div className="space-y-4">
          {/* 翻译引擎选择（共用） */}
          <div className="space-y-2">
            <span className="text-sm text-foreground">{t("settings.translationProvider")}</span>
            <div className="relative" ref={providerPopoverRef}>
              <button
                type="button"
                onClick={() => setProviderOpen(!providerOpen)}
                className="flex w-full items-center justify-between rounded-lg border border-input bg-background px-3 py-2 text-sm hover:bg-muted"
              >
                <span>{currentProvider ? t(currentProvider.labelKey) : t("settings.selectEngine")}</span>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
              {providerOpen && (
                <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-lg border bg-background p-1 shadow-lg">
                  {TRANSLATOR_PROVIDERS.map((provider) => {
                    const isActive = provider.id === translationConfig.provider.id;
                    return (
                      <button
                        key={provider.id}
                        type="button"
                        onClick={() => {
                          handleProviderChange(provider.id);
                          setProviderOpen(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors ${
                          isActive ? "bg-primary/10 text-primary" : "hover:bg-muted"
                        }`}
                      >
                        <span>{t(provider.labelKey)}</span>
                        {isActive && <Check className="h-4 w-4 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* AI 引擎：取词翻译 / 长按翻译 两个独立子栏 */}
          {isAIProvider && (
            <>
              {/* 取词翻译 */}
              <div className="space-y-2 rounded-lg border border-border/60 p-3">
                <span className="text-sm font-medium text-foreground">
                  {t("settings.translationSelectionTitle")}
                </span>
                <p className="text-xs text-muted-foreground">
                  {t("settings.translationSelectionDesc")}
                </p>
                <TranslationModelSelector
                  value={translationConfig.selectionModel}
                  onChange={(s) => updateTranslationConfig({ selectionModel: s })}
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.translationModelUnsetHint")}
                </p>
              </div>

              {/* 长按翻译（词典查词） */}
              <div className="space-y-2 rounded-lg border border-border/60 p-3">
                <span className="text-sm font-medium text-foreground">
                  {t("settings.translationDictionaryTitle")}
                </span>
                <p className="text-xs text-muted-foreground">
                  {t("settings.translationDictionaryDesc")}
                </p>
                <TranslationModelSelector
                  value={translationConfig.dictionaryModel}
                  onChange={(s) => updateTranslationConfig({ dictionaryModel: s })}
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.translationModelUnsetHint")}
                </p>

                {/* 词典查词提示词（仅长按生效） */}
                <div className="space-y-2 pt-1">
                  <span className="text-sm text-foreground">
                    {t("settings.dictionaryPromptTitle")}
                  </span>
                  <Textarea
                    rows={6}
                    value={translationConfig.dictionaryPrompt ?? ""}
                    placeholder={t("settings.dictionaryPromptPlaceholder")}
                    onChange={(e) => updateTranslationConfig({ dictionaryPrompt: e.target.value })}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      {t("settings.dictionaryPromptDesc")}
                    </p>
                    <button
                      type="button"
                      className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                      onClick={() => updateTranslationConfig({ dictionaryPrompt: "" })}
                    >
                      {t("settings.dictionaryPromptReset")}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* DeepL API Key（仅 DeepL 引擎） */}
          {isDeepLProvider && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="translation-deepl-api-key" className="text-sm text-foreground">
                  {t("settings.apiKey")}
                </label>
                <PasswordInput
                  id="translation-deepl-api-key"
                  placeholder={t("settings.apiKeyPlaceholder")}
                  value={translationConfig.provider.apiKey || ""}
                  onChange={(e) => handleApiKeyChange(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t("settings.deeplKeyHint")}</p>
              </div>

              <div className="space-y-2">
                <label htmlFor="translation-deepl-base-url" className="text-sm text-foreground">
                  {t("translation.deeplBaseUrl")}
                </label>
                <Input
                  id="translation-deepl-base-url"
                  placeholder={t("translation.deeplBaseUrlPlaceholder")}
                  value={translationConfig.provider.baseUrl || ""}
                  onChange={(e) => handleBaseUrlChange(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t("translation.deeplBaseUrlHint")}</p>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
