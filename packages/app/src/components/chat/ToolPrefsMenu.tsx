import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useSettingsStore } from "@/stores/settings-store";
import { getModeChoiceTools } from "@readany/core/ai/tools";
import type { AIChatMode } from "@readany/core/types";
import { cn } from "@readany/core/utils";
import { Wrench } from "lucide-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

interface ToolPrefsMenuProps {
  chatMode: AIChatMode;
  className?: string;
}

export function ToolPrefsMenu({ chatMode, className }: ToolPrefsMenuProps) {
  const { t } = useTranslation();
  const aiConfig = useSettingsStore((s) => s.aiConfig);
  const updateAIConfig = useSettingsStore((s) => s.updateAIConfig);

  const mode = chatMode === "lite" ? "lite" : chatMode === "knowledge" ? "knowledge" : null;
  const items = mode ? getModeChoiceTools(mode) : [];
  const enabled = mode ? aiConfig.toolPrefs?.[mode] ?? [] : [];

  const toggle = useCallback(
    (name: string, on: boolean) => {
      if (!mode) return;
      const currentPrefs = aiConfig.toolPrefs ?? {};
      const currentList = currentPrefs[mode] ?? [];
      const nextList = on
        ? [...currentList.filter((n) => n !== name), name]
        : currentList.filter((n) => n !== name);

      updateAIConfig({
        toolPrefs: {
          ...currentPrefs,
          [mode]: nextList,
        },
      });
    },
    [aiConfig.toolPrefs, mode, updateAIConfig],
  );

  // Standard mode has no choice items
  if (!mode || items.length === 0) return null;

  const hasActiveTools = enabled.length > 0;

  return (
    <Popover>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors select-none",
                  hasActiveTools
                    ? "bg-primary/10 text-primary hover:bg-primary/15 font-semibold"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                  className,
                )}
                aria-label={t("chat.toolPrefs", "工具开关")}
              >
                <Wrench className="h-3.5 w-3.5" />
                <span>{t("chat.toolPrefs", "工具")}</span>
                {hasActiveTools && (
                  <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground leading-none">
                    {enabled.length}
                  </span>
                )}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {t("chat.toolPrefsSubtitle", "仅列出当前模式可选的工具")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent align="start" side="top" className="w-80 p-3 shadow-lg">
        <div className="space-y-1 pb-2 border-b">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-foreground">
              {t("chat.toolPrefsTitle", "工具开关")}
            </h4>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase">
              {chatMode}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("chat.toolPrefsSubtitle", "仅列出当前模式可选的工具 (默认关闭)")}
          </p>
        </div>

        <div className="mt-2 max-h-64 overflow-y-auto space-y-1 pr-1">
          {items.map((name) => {
            const isChecked = enabled.includes(name);
            const labelKey = `toolLabels.${name}`;
            const label = t(labelKey, name);

            return (
              <div
                key={name}
                className="flex items-center justify-between py-1.5 px-2 rounded-md hover:bg-muted/40 transition-colors"
              >
                <div className="flex flex-col pr-2 min-w-0">
                  <span className="text-xs font-medium text-foreground truncate">
                    {label}
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono truncate">
                    {name}
                  </span>
                </div>
                <Switch
                  checked={isChecked}
                  onCheckedChange={(checked) => toggle(name, checked)}
                />
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
