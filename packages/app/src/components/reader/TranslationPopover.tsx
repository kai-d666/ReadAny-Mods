/**
 * TranslationPopover — compact floating popover for word lookup and translation
 * Content-driven auto-height with customizable persistent width.
 */
import { useTranslator } from "@/hooks/useTranslator";
import { lookupLocalDictionary, type ECDICTEntry } from "@/lib/ecdict-lookup";
import { useSettingsStore } from "@/stores/settings-store";
import { buildDictionaryPrompt } from "@readany/core/translation/providers";
import {
  TRANSLATOR_PROVIDERS,
  type TranslatorName,
} from "@readany/core/types/translation";
import { BookOpen, Check, ChevronDown, Copy, Loader2, RefreshCw, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface TranslationPopoverProps {
  text: string;
  position: {
    x: number;
    y: number;
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
  onClose: () => void;
  /** Dictionary mode: uses the customizable dictionary prompt instead of the default translation prompt */
  dictionary?: boolean;
  /** Preferred placement relative to anchor (e.g. "below" when SelectionPopover is above) */
  preferPlacement?: "above" | "below" | "right" | "left";
  /** Distance in pixels to avoid from the top edge (e.g. TabBar, Toolbar) */
  topOffset?: number;
}

const DEFAULT_POPOVER_WIDTH = 320;
const POPOVER_MIN_WIDTH = 220;
const POPOVER_FALLBACK_HEIGHT = 80;
const POPOVER_MAX_CONTENT_HEIGHT = 460;
const PADDING = 16;
const GAP = 8;

export function TranslationPopover({
  text,
  position,
  onClose,
  dictionary = false,
  preferPlacement,
  topOffset,
}: TranslationPopoverProps) {
  const { t } = useTranslation();
  const translationConfig = useSettingsStore((s) => s.translationConfig);
  const updateTranslationConfig = useSettingsStore((s) => s.updateTranslationConfig);
  const targetLang = translationConfig.targetLang;

  // Local UI state
  const [translation, setTranslation] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // ECDICT offline lookup state
  const isEcdictMode = dictionary && translationConfig.dictionaryMethod === "ecdict";
  const [ecdictSearching, setEcdictSearching] = useState(false);
  const [ecdictEntry, setEcdictEntry] = useState<ECDICTEntry | null>(null);
  const [ecdictChecked, setEcdictChecked] = useState(false);

  const useDictionaryFallback = translationConfig.dictionaryFallback !== false;

  // 1. Local ECDICT lookup
  useEffect(() => {
    if (!isEcdictMode) {
      setEcdictEntry(null);
      setEcdictSearching(false);
      setEcdictChecked(false);
      return;
    }

    let cancelled = false;
    setEcdictEntry(null);
    setEcdictSearching(true);
    setEcdictChecked(false);

    lookupLocalDictionary(text)
      .then((entry) => {
        if (cancelled) return;
        setEcdictEntry(entry);
      })
      .catch((err) => {
        console.warn("[ECDICT] lookup error for", text, err);
      })
      .finally(() => {
        if (!cancelled) {
          setEcdictSearching(false);
          setEcdictChecked(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [text, isEcdictMode, refreshKey]);

  // Prompt configuration
  const systemPrompt = useMemo(() => {
    if (!dictionary) return undefined;
    return buildDictionaryPrompt(translationConfig.dictionaryPrompt, "AUTO", targetLang, text);
  }, [dictionary, translationConfig.dictionaryPrompt, targetLang, text]);

  const { translate, clearCache, loading, error, provider } = useTranslator({
    targetLang,
    systemPrompt,
    mode: dictionary ? "dictionary" : "selection",
  });

  // Decide if AI/online translation should run:
  // - Selection translation: always online
  // - Dictionary mode with AI engine: always online
  // - Dictionary mode with ECDICT: only when local lookup finished with NO hit AND fallback is enabled
  const shouldRunAI = useMemo(() => {
    if (!dictionary) return true;
    if (translationConfig.dictionaryMethod === "ai") return true;
    if (isEcdictMode && ecdictChecked && !ecdictEntry && useDictionaryFallback) return true;
    return false;
  }, [dictionary, translationConfig.dictionaryMethod, isEcdictMode, ecdictChecked, ecdictEntry, useDictionaryFallback]);

  // In-flight request deduplication for StrictMode / rapid clicks
  const inflightTranslationsRef = useRef<Map<string, Promise<string[]>>>(new Map());

  useEffect(() => {
    if (!shouldRunAI) {
      setTranslation(null);
      return;
    }

    let cancelled = false;
    setTranslation(null);

    const input = text.split("\n").join(" ").trim();
    const requestKey = `${input}:${targetLang}:${translationConfig.provider.id}`;
    let request = inflightTranslationsRef.current.get(requestKey);
    if (!request) {
      request = translate([input]).finally(() => {
        inflightTranslationsRef.current.delete(requestKey);
      });
      inflightTranslationsRef.current.set(requestKey, request);
    }

    request
      .then((results) => {
        if (!cancelled && results[0]) setTranslation(results[0]);
      })
      .catch((err) => {
        console.error("[TranslationPopover] error:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [shouldRunAI, text, targetLang, translate, refreshKey, translationConfig.provider.id]);

  // DOM Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const providerRef = useRef<HTMLDivElement>(null);

  // Width is user-resizable and remembered; height is ALWAYS content-driven (auto)
  const modeKey = dictionary ? "dictionary" : "selection";
  const [width, setWidth] = useState<number>(() => {
    return translationConfig.popoverSize?.[modeKey]?.width ?? DEFAULT_POPOVER_WIDTH;
  });
  const widthRef = useRef(width);
  widthRef.current = width;

  // Resize drag handling (horizontally adjusts width, reflows text & auto-adapts height)
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef({ x: 0, startW: DEFAULT_POPOVER_WIDTH });

  const handleResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeStartRef.current = {
      x: e.clientX,
      startW: widthRef.current,
    };
    setIsResizing(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handleResizePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isResizing) return;
      const deltaX = e.clientX - resizeStartRef.current.x;
      const nextWidth = Math.max(
        POPOVER_MIN_WIDTH,
        Math.min(resizeStartRef.current.startW + deltaX, window.innerWidth - PADDING * 2),
      );
      widthRef.current = nextWidth;
      setWidth(nextWidth);
    },
    [isResizing],
  );

  const handleResizePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isResizing) return;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      setIsResizing(false);
      updateTranslationConfig({
        popoverSize: {
          ...translationConfig.popoverSize,
          [modeKey]: { width: widthRef.current },
        },
      });
    },
    [isResizing, modeKey, updateTranslationConfig, translationConfig.popoverSize],
  );

  // Lock cursor and selection during resize
  useEffect(() => {
    if (isResizing) {
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ew-resize";
    }
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing]);

  // Position calculation with real measured height and boundary clamping
  const calculatePosition = useCallback(
    (preferMode?: "above" | "below" | "right" | "left") => {
      const popoverHeight = containerRef.current?.offsetHeight || POPOVER_FALLBACK_HEIGHT;
      const popoverWidth = widthRef.current || containerRef.current?.offsetWidth || DEFAULT_POPOVER_WIDTH;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // Minimum clearance from window top (accounts for TabBar 32px, toolbar 44px, and padding)
      const topAvoidance = Math.max(PADDING, (topOffset ?? 0) > 0 ? (topOffset ?? 0) : PADDING);

      const anchorTop = position.top ?? position.y;
      const anchorBottom = position.bottom ?? position.y;
      const anchorLeft = position.left ?? position.x;
      const anchorRight = position.right ?? position.x;
      const anchorCenterY = (anchorTop + anchorBottom) / 2;

      const spaceAbove = anchorTop - topAvoidance - GAP;
      const spaceBelow = viewportHeight - anchorBottom - GAP - PADDING;
      const spaceLeft = anchorLeft - GAP;
      const spaceRight = viewportWidth - anchorRight - GAP;

      let x: number;
      let y: number;
      let mode: "above" | "below" | "right" | "left";

      // 1. Explicit user request (e.g. during resize drag preservation or preferPlacement)
      const targetMode = preferMode ?? preferPlacement;
      if (targetMode) {
        if (targetMode === "above" && spaceAbove >= popoverHeight) {
          mode = "above";
          x = position.x;
          y = anchorTop - GAP;
        } else if (targetMode === "below" && spaceBelow >= popoverHeight) {
          mode = "below";
          x = position.x;
          y = anchorBottom + GAP;
        } else if (targetMode === "right" && spaceRight >= popoverWidth) {
          mode = "right";
          x = anchorRight + GAP;
          y = anchorCenterY;
        } else if (targetMode === "left" && spaceLeft >= popoverWidth) {
          mode = "left";
          x = anchorLeft - GAP - popoverWidth;
          y = anchorCenterY;
        } else {
          // Requested mode cannot cleanly fit — fall back to side with more space
          const fitsAbove = spaceAbove >= popoverHeight;
          const fitsBelow = spaceBelow >= popoverHeight;
          if (fitsBelow || spaceBelow >= spaceAbove) {
            mode = "below";
            x = position.x;
            y = anchorBottom + GAP;
          } else if (fitsAbove) {
            mode = "above";
            x = position.x;
            y = anchorTop - GAP;
          } else {
            mode = targetMode;
            x = position.x;
            y = targetMode === "above" ? anchorTop - GAP : anchorBottom + GAP;
          }
        }
      } else if (!dictionary && spaceRight >= popoverWidth) {
        // Selection translation prefers left/right placement
        mode = "right";
        x = anchorRight + GAP;
        y = anchorCenterY;
      } else if (!dictionary && spaceLeft >= popoverWidth) {
        mode = "left";
        x = anchorLeft - GAP - popoverWidth;
        y = anchorCenterY;
      } else {
        // Dictionary lookup or vertical placement:
        // When anchor is in upper half of viewport, strongly prefer BELOW to naturally avoid the top edge.
        // When in lower half, prefer ABOVE to avoid the bottom edge.
        const isUpperHalf = anchorCenterY < viewportHeight / 2;

        if (isUpperHalf && spaceBelow >= popoverHeight) {
          mode = "below";
          x = position.x;
          y = anchorBottom + GAP;
        } else if (!isUpperHalf && spaceAbove >= popoverHeight) {
          mode = "above";
          x = position.x;
          y = anchorTop - GAP;
        } else if (spaceBelow >= popoverHeight) {
          mode = "below";
          x = position.x;
          y = anchorBottom + GAP;
        } else if (spaceAbove >= popoverHeight) {
          mode = "above";
          x = position.x;
          y = anchorTop - GAP;
        } else if (spaceRight >= popoverWidth) {
          mode = "right";
          x = anchorRight + GAP;
          y = anchorCenterY;
        } else if (spaceLeft >= popoverWidth) {
          mode = "left";
          x = anchorLeft - GAP - popoverWidth;
          y = anchorCenterY;
        } else {
          // Tight space: pick whichever side has more room
          if (spaceBelow >= spaceAbove) {
            mode = "below";
            x = position.x;
            y = anchorBottom + GAP;
          } else {
            mode = "above";
            x = position.x;
            y = anchorTop - GAP;
          }
        }
      }

      // 2. Rigid boundary clamping across all modes
      if (mode === "above") {
        const halfWidth = popoverWidth / 2;
        x = Math.max(halfWidth + PADDING, Math.min(x, viewportWidth - halfWidth - PADDING));
        // Popover top in DOM is (y - popoverHeight). Must stay >= topAvoidance!
        if (y - popoverHeight < topAvoidance) {
          if (spaceBelow > spaceAbove) {
            mode = "below";
            y = Math.max(topAvoidance, Math.min(anchorBottom + GAP, viewportHeight - popoverHeight - PADDING));
          } else {
            y = Math.max(topAvoidance + popoverHeight, y);
          }
        }
      } else if (mode === "below") {
        const halfWidth = popoverWidth / 2;
        x = Math.max(halfWidth + PADDING, Math.min(x, viewportWidth - halfWidth - PADDING));
        // Popover top in DOM is y. Must be >= topAvoidance!
        y = Math.max(topAvoidance, y);
        // Popover bottom in DOM is y + popoverHeight. Must stay <= viewportHeight - PADDING!
        if (y + popoverHeight > viewportHeight - PADDING) {
          if (spaceAbove > spaceBelow && spaceAbove >= popoverHeight) {
            mode = "above";
            y = Math.max(topAvoidance + popoverHeight, anchorTop - GAP);
          } else {
            y = Math.min(y, Math.max(topAvoidance, viewportHeight - popoverHeight - PADDING));
          }
        }
      } else {
        // mode === "right" || mode === "left"
        x = Math.max(PADDING, Math.min(x, viewportWidth - popoverWidth - PADDING));
        y = Math.max(
          topAvoidance + popoverHeight / 2,
          Math.min(y, viewportHeight - popoverHeight / 2 - PADDING),
        );
      }

      return { x, y, mode };
    },
    [position, dictionary, preferPlacement, topOffset],
  );

  const [pos, setPos] = useState(() => calculatePosition());
  const posRef = useRef(pos);
  posRef.current = pos;

  // Real-time position update whenever container DOM dimensions change
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setPos(calculatePosition(posRef.current.mode));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [calculatePosition]);

  // Window resize handler
  useEffect(() => {
    const handleResize = () => setPos(calculatePosition());
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [calculatePosition]);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current && !containerRef.current.contains(target)) {
        onClose();
      } else if (providerRef.current && !providerRef.current.contains(target)) {
        setProviderOpen(false);
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Audio pronunciation (TTS)
  const handleSpeak = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const { useTTSStore } = await import("@/stores/tts-store");
      void useTTSStore.getState().play(trimmed);
    } catch {
      try {
        const { EdgeTTSPlayer, DEFAULT_TTS_CONFIG } = await import("@readany/core/tts");
        const player = new EdgeTTSPlayer();
        await player.speak(trimmed, {
          ...DEFAULT_TTS_CONFIG,
          edgeVoice: "en-US-AriaNeural",
        });
      } catch (err) {
        console.warn("[Speak] failed:", err);
      }
    }
  }, [text]);

  // Auto-speak the looked-up word (TTS) when enabled in settings
  useEffect(() => {
    if (!dictionary || !translationConfig.dictionarySpeak) return;
    void handleSpeak();
  }, [dictionary, translationConfig.dictionarySpeak, handleSpeak]);

  // Provider switching
  const handleProviderChange = (providerId: TranslatorName, providerName: string) => {
    updateTranslationConfig({
      provider: {
        ...translationConfig.provider,
        id: providerId,
        name: providerName,
      },
    });
    setProviderOpen(false);
  };

  // Copy result
  const handleCopy = async () => {
    const textToCopy = translation || ecdictEntry?.translation;
    if (textToCopy) {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Provider display name resolution
  const aiConfig = useSettingsStore((s) => s.aiConfig);
  const sel = dictionary ? translationConfig.dictionaryModel : translationConfig.selectionModel;
  const endpointId =
    sel?.endpointId ||
    translationConfig.provider.endpointId ||
    aiConfig.activeEndpointId;
  const endpoint = aiConfig.endpoints.find((e) => e.id === endpointId);
  const providerLabel = TRANSLATOR_PROVIDERS.find((p) => p.id === provider);
  const providerName =
    provider === "ai"
      ? sel?.model || endpoint?.name || "AI"
      : providerLabel
        ? t(providerLabel.labelKey)
        : translationConfig.provider.name;

  // Maximum allowed height to guarantee full viewport & topAvoidance clearance
  const topAvoidance = Math.max(PADDING, (topOffset ?? 0) > 0 ? (topOffset ?? 0) : PADDING);
  const maxAllowedHeight = Math.min(
    POPOVER_MAX_CONTENT_HEIGHT,
    Math.max(160, (typeof window !== "undefined" ? window.innerHeight : 800) - topAvoidance - PADDING * 2),
  );

  return (
    <div
      ref={containerRef}
      className="fixed z-50 select-none"
      style={{
        width,
        maxWidth: "calc(100vw - 32px)",
        left: pos.x,
        top: pos.y,
        transform:
          pos.mode === "above"
            ? "translate(-50%, -100%)"
            : pos.mode === "below"
              ? "translate(-50%, 0)"
              : "translate(0, -50%)",
      }}
    >
      <div
        className="relative flex flex-col overflow-hidden rounded-lg border border-border shadow-lg"
        style={{
          // Content-driven natural auto height!
          height: "auto",
          maxHeight: `${maxAllowedHeight}px`,
          backgroundColor: "var(--background)",
          color: "var(--foreground)",
        }}
      >
        {/* Resize handle (bottom-right: drags width horizontally) */}
        <div
          className="absolute bottom-0 right-0 z-10 flex h-4 w-4 cursor-ew-resize items-end justify-end p-0.5"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
          onPointerCancel={handleResizePointerUp}
          title={t("common.resize", "拖拽调节宽度")}
        >
          <div className="h-2 w-2 border-b-2 border-r-2 border-muted-foreground/40 hover:border-foreground transition-colors" />
        </div>

        {/* Header: Method/Provider + Speak + Refresh */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            {dictionary && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <BookOpen className="h-3.5 w-3.5" />
                <span>
                  {translationConfig.dictionaryMethod === "ecdict"
                    ? t("settings.dictionaryMethodECDICT")
                    : t("settings.dictionaryMethodAI")}
                </span>
              </span>
            )}
            <div className="relative min-w-0" ref={providerRef}>
              <button
                type="button"
                onClick={() => setProviderOpen(!providerOpen)}
                className="flex max-w-28 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                title={providerName}
              >
                <span className="truncate">{providerName}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </button>

              {providerOpen && (
                <div className="absolute left-0 top-full z-50 mt-1 w-40 rounded-md border bg-background p-1 shadow-lg">
                  {TRANSLATOR_PROVIDERS.map((p) => {
                    const label = t(p.labelKey);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => handleProviderChange(p.id, label)}
                        className={`flex w-full items-center justify-between rounded-sm px-2 py-1 text-left text-xs ${
                          p.id === translationConfig.provider.id
                            ? "bg-primary/10 text-primary"
                            : "hover:bg-muted"
                        }`}
                      >
                        <span className="truncate">{label}</span>
                        {p.id === translationConfig.provider.id && <Check className="h-3 w-3" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-0.5">
            {/* Pronounce word in dictionary mode */}
            {dictionary && (
              <button
                type="button"
                title={t("settings.dictionarySpeak", "朗读")}
                className="flex shrink-0 items-center rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => void handleSpeak()}
              >
                <Volume2 className="h-3.5 w-3.5" />
              </button>
            )}

            {/* Quick copy in header (available for both ECDICT and AI translation) */}
            {!loading && !error && (translation || ecdictEntry) && (
              <button
                type="button"
                title={copied ? t("common.copied", "已复制") : t("common.copy", "复制")}
                className="flex shrink-0 items-center rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => void handleCopy()}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            )}

            {/* Refresh cache & retry */}
            {(loading || (!error && translation)) && (
              <button
                type="button"
                title={t("common.retry", "清除缓存并重新翻译")}
                className="flex shrink-0 items-center rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => {
                  void clearCache(text).then(() => setRefreshKey((k) => k + 1));
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Translation content (naturally wraps, scrolls if exceeding maxHeight) */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3 select-text">
          {isEcdictMode && ecdictSearching ? (
            <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{t("common.loading", "查询中...")}</span>
            </div>
          ) : isEcdictMode && ecdictEntry ? (
            <div className="space-y-1.5">
              {ecdictEntry.translation.split("\n").map((line, i) => (
                <div key={i} className="text-sm leading-relaxed">
                  {line}
                </div>
              ))}
              {ecdictEntry.exchange && (
                <div className="text-xs text-muted-foreground">{ecdictEntry.exchange}</div>
              )}
            </div>
          ) : (
            <>
              {loading && (
                <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{t("translation.translating")}</span>
                </div>
              )}

              {error && !loading && <div className="py-1 text-sm text-destructive">{error}</div>}

              {!loading && !error && translation && (
                <>
                  {dictionary && translationConfig.dictionaryMethod === "ecdict" && (
                    <div className="pb-1 text-[10px] text-muted-foreground">
                      {t("settings.dictionaryFallbackHint")}
                    </div>
                  )}
                  <div className="text-sm leading-relaxed whitespace-pre-line">
                    <span>{translation}</span>
                    {/* Float-right inline badge: shares the line with text or smoothly wraps if full */}
                    <span className="float-right ml-2.5 mt-0.5 mr-2 inline-flex items-center gap-1.5 select-none text-xs text-muted-foreground">
                      <span className="text-[10px] opacity-70">{providerName}</span>
                      <button
                        type="button"
                        onClick={handleCopy}
                        className="inline-flex items-center gap-1 rounded border border-border/50 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95"
                        title={copied ? t("common.copied", "已复制") : t("common.copy", "复制")}
                      >
                        {copied ? (
                          <>
                            <Check className="h-3 w-3 text-green-500" />
                            <span className="text-green-500">{t("common.copied", "已复制")}</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" />
                            <span>{t("common.copy", "复制")}</span>
                          </>
                        )}
                      </button>
                    </span>
                  </div>
                </>
              )}

              {!loading && !error && !translation && isEcdictMode && ecdictChecked && !ecdictEntry && !useDictionaryFallback && (
                <div className="py-1 text-sm text-muted-foreground">
                  {t("settings.noDictionaryResult", "未在本地词典中找到该词")}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
