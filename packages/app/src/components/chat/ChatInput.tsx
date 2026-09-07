/**
 * ChatInput — Double-layer card input with smooth sliding drawer architecture.
 *
 * Layer Hierarchy:
 * - Upper Layer (Z-10): Input Card (Textarea + Send Button + Drag Handle).
 *   Slides up and down to reveal and cover the underlying toolbar.
 * - Under Layer (Z-0): Stationary Toolbar (ModeSlider + DeepThinking, ToolPrefs + SpoilerFree).
 *   Anchored at the bottom and remains stationary without translating with the pull.
 * - Visual Occlusion & Full Reveal:
 *   When expanded, the upper card lifts completely clear of the toolbar (+8px gap),
 *   guaranteeing 100% full visibility of Row 1 (ModeSlider + DeepThinking) and Row 2 (Tools + SpoilerFree).
 *   When collapsed, the toolbar aperture closes to 0, completely concealed under the solid input card.
 */
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AIChatMode, AttachedQuote } from "@readany/core/types";
import { cn } from "@readany/core/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { Brain, EyeOff, Quote, Send, SlidersHorizontal, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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

const TOOLBAR_GAP = 8; // Spacing between upper card and lower toolbar when expanded

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

  // Dynamic measurement of stationary toolbar height (full offsetHeight including padding & borders)
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = useState(96);

  // Pointer drag gesture tracking for smooth tactile pull
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const dragStartYRef = useRef(0);
  const dragStartOffsetRef = useRef(0);

  const aiConfig = useSettingsStore((s) => s.aiConfig);
  const updateAIConfig = useSettingsStore((s) => s.updateAIConfig);
  const spoilerFree = aiConfig.spoilerFree[variant];
  const chatMode = aiConfig.chatMode ?? "knowledge";
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resolvedPlaceholder = placeholder || t("chat.inputPlaceholder", "输入消息...");

  // Total expanded lift distance needed to ensure zero clipping and full visibility
  const totalExpansionHeight = toolbarHeight + TOOLBAR_GAP;

  // Measure toolbar's true rendered height dynamically
  useEffect(() => {
    const measureHeight = () => {
      if (!toolbarRef.current) return;
      const el = toolbarRef.current;
      const h = Math.max(el.offsetHeight, el.scrollHeight, 92);
      if (h > 0) {
        setToolbarHeight(h);
      }
    };

    measureHeight();

    if (!toolbarRef.current) return;
    const obs = new ResizeObserver(() => {
      measureHeight();
    });
    obs.observe(toolbarRef.current);
    return () => obs.disconnect();
  }, []);

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

  // Pointer drag handlers on the top handle slot
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragStartYRef.current = e.clientY;
      const baseOffset = expanded ? totalExpansionHeight : 0;
      dragStartOffsetRef.current = baseOffset;
      setDragOffset(baseOffset);
      setIsDragging(true);
    },
    [expanded, totalExpansionHeight],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      // Dragging upwards (clientY decreases) increases lift distance
      const dy = dragStartYRef.current - e.clientY;
      const target = Math.max(0, Math.min(totalExpansionHeight, dragStartOffsetRef.current + dy));
      setDragOffset(target);
    },
    [isDragging, totalExpansionHeight],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      setIsDragging(false);

      const movedDistance = Math.abs(dragStartYRef.current - e.clientY);
      if (movedDistance < 4) {
        // Click gesture without drag
        toggleExpanded();
        return;
      }

      // Drag gesture threshold: snap based on 40% threshold
      const shouldOpen = dragOffset > totalExpansionHeight * 0.4;
      setExpanded(shouldOpen);
      try {
        localStorage.setItem("readany_chat_drawer_expanded", String(shouldOpen));
      } catch {}
    },
    [isDragging, dragOffset, totalExpansionHeight, toggleExpanded],
  );

  const canSend = (value.trim().length > 0 || quotes.length > 0) && !disabled;

  // Active expansion padding and aperture height
  const currentExpansion = isDragging ? dragOffset : expanded ? totalExpansionHeight : 0;
  const currentProgress = totalExpansionHeight > 0 ? currentExpansion / totalExpansionHeight : expanded ? 1 : 0;

  return (
    <div
      className="relative mx-auto w-full max-w-3xl"
      style={{
        paddingBottom: `${currentExpansion}px`,
        transition: isDragging ? "none" : "padding-bottom 240ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      {/* ── 底层: 固定在底部的工具栏卡片 (Stationary Toolbar Under-layer) ── */}
      {/* 核心逻辑: 工具栏在下面绝对不动，展开时输入栏完全抬升到工具栏之上(+8px 间距)，所有工具100%全景展示 */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-0 overflow-hidden select-none pointer-events-none",
          (expanded || isDragging) && "pointer-events-auto",
        )}
        style={{
          height: `${Math.min(toolbarHeight, currentExpansion)}px`,
          transition: isDragging ? "none" : "height 240ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        {/* 工具栏实体卡片: 钉死在最底部 (bottom: 0), 尺寸稳定不晃动 */}
        <div
          ref={toolbarRef}
          className="absolute inset-x-0 bottom-0 rounded-3xl border border-border/50 bg-card/90 dark:bg-card/85 backdrop-blur-md px-4 py-3 space-y-2.5 shadow-sm transition-opacity duration-200"
          style={{
            opacity: currentProgress > 0.08 ? Math.min(1, currentProgress * 1.25) : 0,
          }}
        >
          {/* Row 1: ModeSlider (左) + 深度思考 (右) */}
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

          {/* Row 2: ToolPrefsMenu (左) + 防剧透 (右) */}
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

      {/* ── 上层: 可上下滑动的输入卡片 (Sliding Input Over-layer) ── */}
      {/* 实体不透明背景 (bg-card/98) + 阴影, 落下时完全覆盖底层工具栏 */}
      <div className="relative z-10 w-full rounded-3xl border border-border/70 bg-card/98 dark:bg-card/95 backdrop-blur-md shadow-[0_4px_24px_-4px_rgba(0,0,0,0.08)] dark:shadow-[0_4px_24px_-4px_rgba(0,0,0,0.35)] transition-shadow duration-200 overflow-hidden">
        {/* 顶部手柄条: 支持鼠标按下上下拖拽拉动 与 单击切换 */}
        <div
          role="button"
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleExpanded();
            }
          }}
          className={cn(
            "w-full flex items-center justify-center pt-2 pb-1 select-none group touch-none",
            isDragging ? "cursor-grabbing" : "cursor-grab",
          )}
          title={expanded ? t("chat.collapseDrawer", "收起功能面板 (Alt+O)") : t("chat.expandDrawer", "展开功能面板 (Alt+O)")}
        >
          <div
            className={cn(
              "h-1 rounded-full transition-all duration-200 pointer-events-none",
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

        {/* Input row: Text input + Circular send & Expand toggle */}
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
      </div>
    </div>
  );
}
