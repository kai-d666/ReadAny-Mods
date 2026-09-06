/**
 * ChatInput — Double-layer card input with smooth sliding drawer architecture.
 * Adapted for PC: Clickable top drag handle, expand toggle button, keyboard shortcuts,
 * two-row layout matching Android reference (ModeSlider + DeepThinking, Tools + SpoilerFree),
 * and sleek rounded styling.
 */
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AIChatMode, AttachedQuote } from "@readany/core/types";
import { cn } from "@readany/core/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { Brain, EyeOff, Quote, Send, SlidersHorizontal, Square, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModeSlider } from "./ModeSlider";
import { ToolPrefsMenu } from "./ToolPrefsMenu";

export type { AttachedQuote };

interface ChatInputProps {
  onSend: (
    content: string,
    deepThinking?: boolean,
    spoilerFree?: boolean,
    quotes?: AttachedQuote[],
    chatMode?: AIChatMode,
  ) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
  showDeepThinking?: boolean;
  /** Chat context — each keeps its own persisted spoiler-free state. */
  variant?: "general" | "book";
  quotes?: AttachedQuote[];
  onRemoveQuote?: (id: string) => void;
}

export function ChatInput({
  onSend,
  onStop,
  isStreaming,
  disabled,
  placeholder,
  showDeepThinking = true,
  variant = "general",
  quotes = [],
  onRemoveQuote,
}: ChatInputProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [deepThinking, setDeepThinking] = useState(false);
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem("readany_chat_drawer_expanded") === "true";
    } catch {
      return false;
    }
  });

  const aiConfig = useSettingsStore((s) => s.aiConfig);
  const updateAIConfig = useSettingsStore((s) => s.updateAIConfig);
  const spoilerFree = aiConfig.spoilerFree[variant];
  const chatMode = aiConfig.chatMode ?? "knowledge";
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resolvedPlaceholder = placeholder || t("chat.inputPlaceholder", "输入消息...");

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("readany_chat_drawer_expanded", String(next));
      } catch {}
      return next;
    });
  }, []);

  const handleModeChange = useCallback(
    (newMode: AIChatMode) => {
      updateAIConfig({ chatMode: newMode });
    },
    [updateAIConfig],
  );

  const handleSend = useCallback(
    (useDeepThinking: boolean = deepThinking) => {
      const trimmed = value.trim();
      if (trimmed || quotes.length > 0) {
        onSend(
          trimmed,
          useDeepThinking,
          spoilerFree,
          quotes.length > 0 ? quotes : undefined,
          chatMode,
        );
        setValue("");
        if (textareaRef.current) {
          textareaRef.current.style.height = "auto";
        }
      }
    },
    [value, deepThinking, spoilerFree, onSend, quotes, chatMode],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        toggleExpanded();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, toggleExpanded],
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  }, []);

  const toggleDeepThinking = useCallback(() => {
    setDeepThinking((prev) => !prev);
  }, []);

  const toggleSpoilerFree = useCallback(() => {
    updateAIConfig({
      spoilerFree: { ...aiConfig.spoilerFree, [variant]: !aiConfig.spoilerFree[variant] },
    });
  }, [aiConfig, variant, updateAIConfig]);

  const canSend = (value.trim().length > 0 || quotes.length > 0) && !disabled;

  return (
    <div className="mx-auto w-full max-w-3xl">
      {/* Outer Card: Two-layer architecture matching Android reference */}
      <div className="relative rounded-3xl border border-border/60 bg-card/95 backdrop-blur-md shadow-[0_4px_24px_-4px_rgba(0,0,0,0.08)] dark:shadow-[0_4px_24px_-4px_rgba(0,0,0,0.35)] transition-all duration-200 overflow-hidden">
        {/* Top Handle Slot: Click to toggle drawer with visual hint */}
        <div
          role="button"
          tabIndex={0}
          onClick={toggleExpanded}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleExpanded();
            }
          }}
          className="w-full flex items-center justify-center pt-2 pb-0.5 cursor-pointer group select-none"
          title={expanded ? t("chat.collapseDrawer", "收起功能面板 (Alt+O)") : t("chat.expandDrawer", "展开功能面板 (Alt+O)")}
        >
          <div
            className={cn(
              "h-1 rounded-full transition-all duration-200",
              expanded
                ? "w-12 bg-primary/40 group-hover:bg-primary/70 group-hover:w-16"
                : "w-9 bg-muted-foreground/30 group-hover:bg-muted-foreground/60 group-hover:w-14",
            )}
          />
        </div>

        {/* Attached quotes chips */}
        {quotes.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pt-1 pb-1">
            <TooltipProvider delayDuration={300}>
              {quotes.map((q) => (
                <Tooltip key={q.id}>
                  <TooltipTrigger asChild>
                    <span className="group inline-flex max-w-[220px] items-center gap-1 rounded-md border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs text-primary">
                      <Quote className="size-3 shrink-0 opacity-60" />
                      <span className="truncate">{q.text}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveQuote?.(q.id);
                        }}
                        className="ml-0.5 shrink-0 rounded-full p-0.5 opacity-0 transition-opacity hover:bg-primary/10 group-hover:opacity-100"
                      >
                        <X className="size-2.5" />
                      </button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    className="max-w-xs whitespace-pre-wrap bg-popover text-popover-foreground border shadow-md"
                  >
                    <p className="text-xs leading-relaxed">
                      {q.text.length > 300 ? `${q.text.slice(0, 300)}...` : q.text}
                    </p>
                    {q.source && (
                      <p className="mt-1 text-[10px] text-muted-foreground">— {q.source}</p>
                    )}
                  </TooltipContent>
                </Tooltip>
              ))}
            </TooltipProvider>
          </div>
        )}

        {/* Upper Layer: Text input + Circular send & Expand toggle */}
        <div className="flex items-end px-4 pb-2.5 pt-0.5 gap-2">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              handleInput();
            }}
            onKeyDown={handleKeyDown}
            placeholder={quotes.length > 0 ? t("chat.askAboutQuote", "关于选中的文本提问...") : resolvedPlaceholder}
            disabled={disabled}
            rows={1}
            className="flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed placeholder:text-muted-foreground/70 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            style={{ minHeight: 34, maxHeight: 160 }}
          />

          <div className="flex items-center gap-1.5 shrink-0 pb-0.5 select-none">
            {/* Drawer Expand/Collapse Toggle Button */}
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={toggleExpanded}
                    className={cn(
                      "size-8 rounded-full flex items-center justify-center transition-all duration-200 text-muted-foreground hover:text-foreground hover:bg-muted/60",
                      expanded && "text-primary bg-primary/10 hover:bg-primary/15",
                    )}
                    aria-label={expanded ? "收起功能面板" : "展开功能面板"}
                  >
                    <SlidersHorizontal className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {expanded ? t("chat.collapseDrawer", "收起功能面板 (Alt+O)") : t("chat.expandDrawer", "展开功能面板 (Alt+O)")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {/* Circular Send / Stop Button */}
            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                className="size-8 rounded-full border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20 flex items-center justify-center transition-transform hover:scale-105 active:scale-95 shadow-sm"
                title={t("chat.stop", "停止生成")}
              >
                <Square className="size-3 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleSend()}
                disabled={!canSend}
                className={cn(
                  "size-8 rounded-full flex items-center justify-center border transition-all duration-200 shadow-sm",
                  canSend
                    ? "border-primary/40 bg-primary text-primary-foreground hover:scale-105 active:scale-95 cursor-pointer"
                    : "border-border/60 bg-muted/20 text-muted-foreground/40 cursor-not-allowed",
                )}
                title={t("chat.send", "发送")}
              >
                <Send className="size-3.5 -ml-0.5" />
              </button>
            )}
          </div>
        </div>

        {/* Lower Layer: Sliding Function Drawer (ModeSlider + DeepThinking, Tools + SpoilerFree) */}
        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-200 ease-out border-t border-border/40",
            expanded
              ? "grid-rows-[1fr] opacity-100 bg-muted/20 dark:bg-muted/10"
              : "grid-rows-[0fr] opacity-0 pointer-events-none border-t-transparent",
          )}
        >
          <div className="overflow-hidden">
            <div className="px-4 py-2.5 space-y-2">
              {/* Row 1: ModeSlider (left) + Deep Thinking (right) */}
              <div className="flex items-center justify-between gap-2">
                <ModeSlider mode={chatMode} onChange={handleModeChange} />

                {showDeepThinking && (
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={toggleDeepThinking}
                          className={cn(
                            "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all select-none shrink-0",
                            deepThinking
                              ? "border-primary/50 bg-primary/10 text-primary shadow-xs"
                              : "border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/60",
                          )}
                        >
                          <Brain className="size-3.5" />
                          <span>{t("chat.deepThinking", "深度思考")}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs max-w-xs">
                        {t("chat.deepThinkingHint", "启用更深入的分析和推理过程，响应时间可能更长")}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>

              {/* Row 2: ToolPrefsMenu (left) + Spoiler Free (right) */}
              <div className="flex items-center justify-between gap-2">
                <ToolPrefsMenu chatMode={chatMode} />

                {showDeepThinking && (
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={toggleSpoilerFree}
                          className={cn(
                            "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all select-none shrink-0 ml-auto",
                            spoilerFree
                              ? "border-primary/50 bg-primary/10 text-primary shadow-xs"
                              : "border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/60",
                          )}
                        >
                          <EyeOff className="size-3.5" />
                          <span>{t("chat.spoilerFree", "防剧透")}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs max-w-xs">
                        {t("chat.spoilerFreeHint", "AI 将避免透露当前阅读进度之后的内容")}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
