import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSettingsStore } from "@/stores/settings-store";
import type { AIModelSelection } from "@readany/core/types/translation";
import { useTranslation } from "react-i18next";
import { SearchableModelSelect } from "./SearchableModelSelect";

interface TranslationModelSelectorProps {
  value?: AIModelSelection;
  onChange: (selection: AIModelSelection) => void;
}

/** Endpoint + model selector for one translation sub-panel (selection / dictionary). */
export function TranslationModelSelector({ value, onChange }: TranslationModelSelectorProps) {
  const { t } = useTranslation();
  const aiConfig = useSettingsStore((s) => s.aiConfig);
  const endpoints = aiConfig.endpoints;

  // Prefer the stored endpoint; if it was deleted, fall back to the first one
  // for display only (a new selection writes the effective endpoint back).
  const storedEndpoint = endpoints.find((e) => e.id === value?.endpointId);
  const displayEndpoint = storedEndpoint ?? endpoints[0];

  const models = displayEndpoint?.models ?? [];

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
          <SearchableModelSelect
            models={models}
            value={value?.model}
            onValueChange={(m) => onChange({ endpointId: displayEndpoint.id, model: m })}
            placeholder={t("settings.ai_selectModel")}
          />
        ) : (
          <p className="text-xs text-muted-foreground">{t("settings.noModelsFetched")}</p>
        )}
      </div>
    </div>
  );
}
