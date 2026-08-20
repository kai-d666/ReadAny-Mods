/**
 * ModelSelector — inline model switcher for chat headers.
 * Only shows the models of the currently active endpoint
 * (the endpoint itself is chosen in Settings → AI → AI Assistant).
 * Selecting a model does not change the endpoint.
 */
import { useSettingsStore } from "@/stores/settings-store";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export function ModelSelector() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);

  const { aiConfig, setActiveModel } = useSettingsStore();
  const currentModel = aiConfig.activeModel;

  const activeEndpoint = aiConfig.endpoints.find((e) => e.id === aiConfig.activeEndpointId);
  const models = activeEndpoint?.models ?? [];
  const filteredModels = search.trim()
    ? models.filter((m) => m.toLowerCase().includes(search.toLowerCase()))
    : models;
  const hasActiveModel = currentModel !== "" && models.includes(currentModel);
  const configured = !!activeEndpoint && models.length > 0;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const displayName = hasActiveModel
    ? currentModel.length > 20
      ? `${currentModel.slice(0, 18)}...`
      : currentModel
    : t("chat.modelNotConfigured");

  const canSwitch = configured && models.length > 1;

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => canSwitch && setOpen(!open)}
        className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors ${
          canSwitch ? "cursor-pointer hover:bg-muted hover:text-foreground" : "cursor-default"
        }`}
        title={hasActiveModel ? currentModel : t("chat.modelNotConfigured")}
      >
        <span className="max-w-[120px] truncate">{displayName}</span>
        {canSwitch && <ChevronDown className="size-3 shrink-0" />}
      </button>

      {open && canSwitch && activeEndpoint && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-60 rounded-xl border bg-background p-1 shadow-lg">
          <div className="px-2.5 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {activeEndpoint.name || activeEndpoint.baseUrl}
          </div>
          <input
            type="text"
            className="mx-1.5 mb-1 h-7 w-[calc(100%-12px)] px-2.5 text-xs border rounded-md bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder={t("settings.ai_searchModels")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="max-h-56 overflow-y-auto">
            {filteredModels.length === 0 ? (
              <div className="px-3 py-2 text-center text-xs text-muted-foreground">
                {t("settings.ai_noMatchingResults")}
              </div>
            ) : (
              filteredModels.map((model) => {
                const isActive = model === currentModel;
                return (
                  <button
                    key={model}
                    type="button"
                    onClick={() => {
                      setActiveModel(model);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                      isActive ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted"
                    }`}
                  >
                    <span className="truncate">{model}</span>
                    {isActive && <Check className="size-3 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
