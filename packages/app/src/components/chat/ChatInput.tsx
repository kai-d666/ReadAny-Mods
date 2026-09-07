/**
 * ChatInput — Double-layer card input with smooth sliding drawer architecture.
 * Replicating the exact Android mathematical & visual model:
 *
 * 1. Layer Hierarchy:
 *    - Upper Layer (combo, Z-10): The rounded input card (textarea + send button + drag slot).
 *      Fully rounded (rounded-3xl), opaque background, subtle shadow.
 *    - Under Layer (layerPanel, Z-0): The tool card body.
 *      Anchored at bottom: 0. Top edge extends up to combo's center line (top: comboHeight / 2).
 *      Has border-x, border-b, border-t-0, rounded-b-3xl, rounded-t-0.
 *      combo's bottom rounded corners sit directly on layerPanel's card surface!
 *
 * 2. Motion & Full Reveal:
 *    - In collapsed state (paddingBottom: 0):
 *      layerPanel height is only comboHeight / 2, completely hidden behind combo.
 *    - In expanded state (paddingBottom: expandHeight):
 *      combo is raised by expandHeight.
 *      layerPanel's bottom stays at bottom: 0 (completely stationary!).
 *      toolArea is pinned at layerPanel's bottom, perfectly revealed below combo with zero clipping.
 *      The side borders of layerPanel seamlessly extend up behind combo!
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

  // Dynamic measurements: upper card height (combo) & tool area height
  const comboRef = useRef<HTMLDivElement>(null);
  const toolAreaRef = useRef<HTMLDivElement>(null);
  const [comboHeight, setComboHeight] = useState(52);
  const [expandHeight, setExpandHeight] = useState(86);

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

  // Measure combo (upper card) height
  useEffect(() => {
    const measureCombo = () => {
      if (comboRef.current) {
        const h = Math.max(comboRef.current.offsetHeight, 46);
        setComboHeight(h);
      }
    };
    measureCombo();
    if (!comboRef.current) return;
    const obs = new ResizeObserver(measureCombo);
    obs.observe(comboRef.current);
    return () => obs.disconnect();
  }, [value, quotes]);

  // Measure toolArea (tools in under layer) height
  useEffect(() => {
    const measureTool = () => {
      if (toolAreaRef.current) {
        const h = Math.max(toolAreaRef.current.offsetHeight, 80);
        setExpandHeight(h);
      }
    };
    measureTool();
    if (!toolAreaRef.current) return;
    const obs = new ResizeObserver(measureTool);
    obs.observe(toolAreaRef.current);
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
      const baseOffset = expanded ? expandHeight : 0;
      dragStartOffsetRef.current = baseOffset;
      setDragOffset(baseOffset);
      setIsDragging(true);
    },
    [expanded, expandHeight],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      // Dragging upwards (clientY decreases) increases lift distance
      const dy = dragStartYRef.current - e.clientY;
      const target = Math.max(0, Math.min(expandHeight, dragStartOffsetRef.current + dy));
      setDragOffset(target);
    },
    [isDragging, expandHeight],
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
      const shouldOpen = dragOffset > expandHeight * 0.4;
      setExpanded(shouldOpen);
      try {
        localStorage.setItem("readany_chat_drawer_expanded", String(shouldOpen));
      } catch {}
    },
    [isDragging, dragOffset, expandHeight, toggleExpanded],
  );

  const canSend = (value.trim().length > 0 || quotes.length > 0) && !disabled;

  // Active expansion lift distance
  const currentLift = isDragging ? dragOffset : expanded ? expandHeight : 0;
  const isLayerActive = expanded || isDragging || currentLift > 0;

  return (
    <div
      className="relative mx-auto w-full max-w-3xl"
      style={{
        paddingBottom: `${currentLift}px`,
        transition: isDragging ? "none" : "padding-bottom 220ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      {/* ── 底层: layerPanel (实体大卡, 完美对齐 Android 双层架构) ── */}
      {/* 顶端延伸到上层卡片中心线 (top: comboHeight / 2), 底端锚定最底部 (bottom: 0) */}
      {/* 上层下圆角坐在下层卡面上 (弧外三角区为下层实体卡面), 侧边框向上延伸, 形成一体化机械嵌合 */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-0 flex flex-col justify-end overflow-hidden select-none border-x border-b border-border/70 bg-card/90 dark:bg-card/85 shadow-sm transition-opacity duration-200",
          isLayerActive ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        style={{
          top: `${Math.round(comboHeight / 2)}px`,
          borderBottomLeftRadius: "1.75rem",
          borderBottomRightRadius: "1.75rem",
          borderTopLeftRadius: "0",
          borderTopRightRadius: "0",
          borderTopWidth: 0,
        }}
      >
        {/* 工具内容区 (toolArea): 停靠在卡壳底部, 向上展开时完全在 combo 下方呈现 */}
        <div
          ref={toolAreaRef}
          className="w-full px-4 pt-2 pb-2.5 space-y-2"
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

      {/* ── 上层: combo 输入卡 (唯一运动层, 坐在下层卡面上) ── */}
      {/* 独立完整圆角 (rounded-3xl) + 实体背景 (bg-background/98) + 阴影 */}
      <div
        ref={comboRef}
        className="relative z-10 w-full rounded-3xl border border-border/75 bg-background/98 dark:bg-background/95 backdrop-blur-md shadow-[0_2px_12px_-2px_rgba(0,0,0,0.08)] dark:shadow-[0_4px_16px_-2px_rgba(0,0,0,0.4)] overflow-hidden"
      >
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
