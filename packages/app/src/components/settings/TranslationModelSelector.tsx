import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSettingsStore } from "@/stores/settings-store";
import type { AIModelSelection } from "@readany/core/types/translation";
import { useState } from "react";
import { useTranslation } from "react-i18next";

interface TranslationModelSelectorProps {
  value?: AIModelSelection;
  onChange: (selection: AIModelSelection) => void;
}

/** Endpoint + model selector for one translation sub-panel (selection / dictionary). */
export function TranslationModelSelector({ value, onChange }: TranslationModelSelectorProps) {
  const { t } = useTranslation();
  const aiConfig = useSettingsStore((s) => s.aiConfig);
  const endpoints = aiConfig.endpoints;
  const [search, setSearch] = useState("");

  // Prefer the stored endpoint; if it was deleted, fall back to the first one
  // for display only (a new selection writes the effective endpoint back).
  const storedEndpoint = endpoints.find((e) => e.id === value?.endpointId);
  const displayEndpoint = storedEndpoint ?? endpoints[0];

  const models = displayEndpoint?.models ?? [];
  const filteredModels = search.trim()
    ? models.filter((m) => m.toLowerCase().includes(search.toLowerCase()))
    : models;

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <span className="text-xs text-muted-foreground">{t("settings.translationEndpoint")}</span>
        {endpoints.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("settings.ai_noEndpoints")}</p>
        ) : (
          <Select
            value={storedEndpoint ? storedEndpoint.id : undefined}
            onValueChange={(id) => {
              setSearch("");
              onChange({ endpointId: id, model: "" });
            }}
          >
            <SelectTrigger className="h-8 w-full text-sm">
              <SelectValue placeholder={t("settings.ai_selectEndpoint")} />
            </SelectTrigger>
            <SelectContent>
              {endpoints.map((ep) => (
                <SelectItem key={ep.id} value={ep.id}>
                  {ep.name || ep.baseUrl}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="space-y-1.5">
        <span className="text-xs text-muted-foreground">{t("settings.model")}</span>
        {models.length > 0 ? (
          <Select
            value={value?.model}
            onValueChange={(m) => onChange({ endpointId: displayEndpoint.id, model: m })}
          >
            <SelectTrigger className="h-8 w-full text-sm">
              <SelectValue placeholder={t("settings.ai_selectModel")} />
            </SelectTrigger>
            <SelectContent className="max-h-[320px]">
              <div className="border-b p-1.5">
                <Input
                  type="text"
                  className="h-7 text-xs"
                  placeholder={t("settings.ai_searchModels")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </div>
              <div className="max-h-[240px] overflow-y-auto">
                {filteredModels.length === 0 ? (
                  <div className="px-3 py-2 text-center text-xs text-muted-foreground">
                    {t("settings.ai_noMatchingResults")}
                  </div>
                ) : (
                  filteredModels.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))
                )}
              </div>
            </SelectContent>
          </Select>
        ) : (
          <p className="text-xs text-muted-foreground">{t("settings.noModelsFetched")}</p>
        )}
      </div>
    </div>
  );
}
