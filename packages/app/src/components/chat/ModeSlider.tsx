import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AIChatMode } from "@readany/core/types";
import { cn } from "@readany/core/utils";
import { useTranslation } from "react-i18next";

interface ModeSliderProps {
  mode: AIChatMode;
  onChange: (mode: AIChatMode) => void;
  className?: string;
}

const MODES: Array<{
  id: AIChatMode;
  labelKey: string;
  defaultLabel: string;
  hintKey: string;
  defaultHint: string;
}> = [
  {
    id: "standard",
    labelKey: "chat.chatModeStandard",
    defaultLabel: "标准",
    hintKey: "chat.chatModeStandardHint",
    defaultHint: "标准模式: 完整功能与深度考据(支持点击引用)",
  },
  {
    id: "lite",
    labelKey: "chat.chatModeLite",
    defaultLabel: "Lite",
    hintKey: "chat.chatModeLiteHint",
    defaultHint: "快速直连模式: 响应更快, 围绕当前章节问答",
  },
  {
    id: "knowledge",
    labelKey: "chat.chatModeKnowledge",
    defaultLabel: "K-O",
    hintKey: "chat.chatModeKnowledgeHint",
    defaultHint: "Knowledge-Only: 纯靠知识库答疑, 极速且零工具开销",
  },
];

export function ModeSlider({ mode, onChange, className }: ModeSliderProps) {
  const { t } = useTranslation();

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          "inline-flex items-center rounded-lg bg-muted/60 p-0.5 border border-border/50 text-xs font-medium select-none",
          className,
        )}
      >
        {MODES.map((item) => {
          const isActive = mode === item.id;
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onChange(item.id)}
                  className={cn(
                    "px-2.5 py-1 rounded-md transition-all duration-150 text-[11px] leading-none font-medium",
                    isActive
                      ? "bg-background text-foreground shadow-sm font-semibold"
                      : "text-muted-foreground hover:text-foreground hover:bg-background/40",
                  )}
                >
                  {t(item.labelKey, item.defaultLabel)}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs max-w-xs">
                {t(item.hintKey, item.defaultHint)}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
