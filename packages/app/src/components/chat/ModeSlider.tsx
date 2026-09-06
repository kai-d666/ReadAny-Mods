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
  const activeIndex = MODES.findIndex((m) => m.id === mode);
  const safeIndex = activeIndex >= 0 ? activeIndex : 2; // Default knowledge (2)

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          "relative inline-flex items-center h-7 w-[190px] rounded-full bg-muted/60 dark:bg-muted/40 p-0.5 border border-border/50 select-none shadow-inner",
          className,
        )}
      >
        {/* Raised sliding pill thumb */}
        <div
          className="absolute top-0.5 bottom-0.5 rounded-full bg-background dark:bg-card shadow-sm border border-border/60 transition-all duration-200 ease-out"
          style={{
            width: "calc((100% - 4px) / 3)",
            left: `calc(2px + ${safeIndex} * ((100% - 4px) / 3))`,
          }}
        />

        {/* Mode segments */}
        {MODES.map((item) => {
          const isActive = mode === item.id;
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onChange(item.id)}
                  className={cn(
                    "relative z-10 flex-1 h-full rounded-full text-center text-[11px] leading-none transition-colors duration-150 flex items-center justify-center font-medium",
                    isActive
                      ? "text-foreground font-semibold"
                      : "text-muted-foreground hover:text-foreground",
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
