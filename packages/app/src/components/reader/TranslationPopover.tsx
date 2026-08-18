import { useTranslator } from "@/hooks/useTranslator";
/**
 * TranslationPopover — compact floating popover for translation
 * Robust positioning: always stays within viewport
 */
import { lookupLocalDictionary, type ECDICTEntry } from "@/lib/ecdict-lookup";
import { useSettingsStore } from "@/stores/settings-store";
import { buildDictionaryPrompt } from "@readany/core/translation/providers";
import {
  TRANSLATOR_PROVIDERS,
  type TranslationTargetLang,
  type TranslatorName,
} from "@readany/core/types/translation";
import { BookOpen, Check, ChevronDown, Copy, Loader2, RefreshCw } from "lucide-react";
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
}

const POPOVER_WIDTH = 288; // w-72 = 18rem = 288px
const POPOVER_MIN_HEIGHT = 100; // header + content min height
const POPOVER_MAX_HEIGHT = 200; // max total height
const POPOVER_MIN_WIDTH = 220;
const PADDING = 16;
const GAP = 8;

export function TranslationPopover({
  text,
  position,
  onClose,
  dictionary = false,
}: TranslationPopoverProps) {
  const { t } = useTranslation();
  const translationConfig = useSettingsStore((s) => s.translationConfig);
  const updateTranslationConfig = useSettingsStore((s) => s.updateTranslationConfig);

  // Local state
  const [targetLang] = useState<TranslationTargetLang>(translationConfig.targetLang);
  const [translation, setTranslation] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerRevision, setProviderRevision] = useState(0);
  const translationRequestKey = `${targetLang}:${providerRevision}`;

  // Bump to force a fresh request after clearing the cache
  const [refreshKey, setRefreshKey] = useState(0);
  // Local ECDICT hit (offline, fastest) — checked first for any dictionary lookup
  const [ecdictEntry, setEcdictEntry] = useState<ECDICTEntry | null>(null);
  // Gate: AI must wait until the local lookup settles, otherwise a local hit
  // would race with an already-fired AI request and overwrite the result.
  // Uses a ref for the *instant* gate (state would not be visible to effects
  // running in the same commit) + state to re-render when the gate opens.
  const [ecdictChecking, setEcdictChecking] = useState(false);
  const ecdictCheckingRef = useRef(false);
  // Bumped after the local lookup settles — forces the AI effect to re-evaluate
  // (setState for the gate can be batched away, leaving deps unchanged).
  const [ecdictDoneTick, setEcdictDoneTick] = useState(0);
  // Non-AI method (ECDICT) falls back to AI only when enabled.
  // Declared early — effects below reference it (avoid TDZ).
  const useDictionaryFallback =
    translationConfig.dictionaryFallback !== false;

  // Local dictionary lookup — only in ECDICT mode (the chosen method decides
  // the primary engine; AI mode goes straight to AI). Hits skip AI fallback.
  useEffect(() => {
    if (!dictionary || translationConfig.dictionaryMethod !== "ecdict") return;
    let cancelled = false;
    setEcdictEntry(null);
    ecdictCheckingRef.current = true;
    setEcdictChecking(true);
    lookupLocalDictionary(text)
      .then((entry) => {
        if (cancelled) return;
        console.log("[ECDICT] word:", text, "hit:", !!entry);
        setEcdictEntry(entry);
      })
      .finally(() => {
        ecdictCheckingRef.current = false;
        setEcdictDoneTick((t) => t + 1);
        if (!cancelled) setEcdictChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dictionary, translationConfig.dictionaryMethod, text, refreshKey]);
  // Dictionary mode resolves its own prompt from settings (live targetLang, so
  // switching the language in the popover re-renders the prompt too).
  const systemPrompt = useMemo(() => {
    if (!dictionary) return undefined;
    const p = buildDictionaryPrompt(translationConfig.dictionaryPrompt, "AUTO", targetLang, text);
    console.log("[DictPrompt] word:", text, "prompt:", p.slice(0, 120));
    return p;
  }, [dictionary, translationConfig.dictionaryPrompt, targetLang, text]);

  const { translate, clearCache, loading, error, provider } = useTranslator({
    targetLang,
    systemPrompt,
    mode: dictionary ? "dictionary" : "selection",
  });

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const providerRef = useRef<HTMLDivElement>(null);

  // Resizable size (height null = auto until the user drags the handle).
  // Restores the last dragged size from settings. Resizing only changes the
  // box — position stays put (no jumping). Pointer capture is released on
  // pointerup AND pointercancel so the popover never gets "dragged along".
  const [size, setSize] = useState<{ width: number; height: number | null }>(
    translationConfig.popoverSize?.[dictionary ? "dictionary" : "selection"] ?? {
      width: POPOVER_WIDTH,
      height: null,
    },
  );
  const sizeRef = useRef(size);
  sizeRef.current = size;

  // Deduplicate in-flight translation requests: React StrictMode runs effects
  // twice in dev, which would fire two identical API calls per lookup — a
  // fast path to provider rate limits (SiliconFlow hangs silently when
  // rate-limited). The second effect reuses the first request instead.
  const inflightTranslationsRef = useRef<Map<string, Promise<string[]>>>(new Map());

  // Resize drag state (follows the project's ResizeHandle pattern: element-level
  // pointer events + setPointerCapture + userSelect lock).
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef({ x: 0, y: 0, w: POPOVER_WIDTH, h: POPOVER_MIN_HEIGHT });

  // Prevent text selection while dragging (ResizeHandle pattern)
  useEffect(() => {
    if (isResizing) {
      document.body.style.userSelect = "none";
      document.body.style.cursor = "se-resize";
    }
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing]);

  // Cleanup on unmount (popover might close while dragging)
  useEffect(() => {
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, []);

  // Position: above the anchor when there is room, else below; when there is
  // no vertical room at all, flip to the anchor's right (then left). Anchored
  // on the word/selection's edges so it never covers it.
  // preferMode: keep the current direction (used after a resize) — the box is
  // re-clamped to the viewport without switching direction.
  const calculatePosition = useCallback(
    (preferMode?: "above" | "below" | "right" | "left") => {
    const popoverHeight =
      sizeRef.current.height ??
      Math.min(
        containerRef.current?.offsetHeight || POPOVER_MIN_HEIGHT,
        POPOVER_MAX_HEIGHT,
      );
    const popoverWidth = containerRef.current?.offsetWidth || POPOVER_WIDTH;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const anchorTop = position.top ?? position.y;
    const anchorBottom = position.bottom ?? position.y;
    const anchorLeft = position.left ?? position.x;
    const anchorRight = position.right ?? position.x;
    const anchorCenterY = (anchorTop + anchorBottom) / 2;

    const spaceAbove = anchorTop - GAP;
    const spaceBelow = viewportHeight - anchorBottom - GAP;
    const spaceLeft = anchorLeft - GAP;
    const spaceRight = viewportWidth - anchorRight - GAP;

    let x: number;
    let y: number;
    let mode: "above" | "below" | "right" | "left";

    if (preferMode) {
      mode = preferMode;
      if (mode === "above") {
        x = position.x;
        y = anchorTop - GAP;
      } else if (mode === "below") {
        x = position.x;
        y = anchorBottom + GAP;
      } else if (mode === "right") {
        x = anchorRight + GAP;
        y = anchorCenterY;
      } else {
        x = anchorLeft - GAP - popoverWidth;
        y = anchorCenterY;
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
    } else if (spaceAbove >= popoverHeight) {
      mode = "above";
      x = position.x;
      y = anchorTop - GAP;
    } else if (spaceBelow >= popoverHeight) {
      mode = "below";
      x = position.x;
      y = anchorBottom + GAP;
    } else if (spaceRight >= popoverWidth) {
      // No vertical room — place to the right of the anchor
      mode = "right";
      x = anchorRight + GAP;
      y = anchorCenterY;
    } else if (spaceLeft >= popoverWidth) {
      // No vertical room and no right room — place to the left
      mode = "left";
      x = anchorLeft - GAP - popoverWidth;
      y = anchorCenterY;
    } else {
      // Nothing fits — use the side with the most room, clamped
      const rooms = [
        { mode: "above" as const, room: spaceAbove },
        { mode: "below" as const, room: spaceBelow },
        { mode: "right" as const, room: spaceRight },
        { mode: "left" as const, room: spaceLeft },
      ].sort((a, b) => b.room - a.room)[0];
      mode = rooms.mode;
      if (mode === "above") {
        x = position.x;
        y = PADDING + popoverHeight;
      } else if (mode === "below") {
        x = position.x;
        y = anchorBottom + GAP;
        y = Math.min(y, viewportHeight - popoverHeight - PADDING);
      } else if (mode === "right") {
        x = anchorRight + GAP;
        y = anchorCenterY;
      } else {
        x = anchorLeft - GAP - popoverWidth;
        y = anchorCenterY;
      }
    }

    // Clamp to viewport
    if (mode === "above" || mode === "below") {
      const halfWidth = popoverWidth / 2;
      x = Math.max(halfWidth + PADDING, Math.min(x, viewportWidth - halfWidth - PADDING));
    } else {
      y = Math.max(
        PADDING + popoverHeight / 2,
        Math.min(y, viewportHeight - popoverHeight / 2 - PADDING),
      );
    }

    return { x, y, mode };
  }, [position, dictionary]);

  // Resize handlers are defined after calculatePosition — their deps reference
  // it and would hit TDZ otherwise (this caused a white-screen crash before).
  const handleResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      w: sizeRef.current.width,
      h: sizeRef.current.height ?? containerRef.current?.offsetHeight ?? POPOVER_MIN_HEIGHT,
    };
    setIsResizing(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handleResizePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isResizing) return;
      const { x, y, w, h } = resizeStartRef.current;
      const next = {
        width: Math.max(POPOVER_MIN_WIDTH, Math.min(w + (e.clientX - x), window.innerWidth - PADDING * 2)),
        height: Math.max(POPOVER_MIN_HEIGHT, Math.min(h + (e.clientY - y), window.innerHeight - PADDING * 2)),
      };
      sizeRef.current = next;
      setSize(next);
      // Real-time position update during the drag (keep direction, clamp to viewport)
      setPos(calculatePosition(posRef.current.mode));
    },
    [isResizing, calculatePosition],
  );

  const handleResizePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isResizing) return;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      setIsResizing(false);
      // Remember the dragged size for this mode (selection / dictionary)
      updateTranslationConfig({
        popoverSize: {
          ...translationConfig.popoverSize,
          [dictionary ? "dictionary" : "selection"]: sizeRef.current,
        },
      });
      // Re-anchor with the final size, keeping the current direction so the
      // box never escapes the viewport (and never jumps direction).
      setPos(calculatePosition(posRef.current.mode));
    },
    [isResizing, updateTranslationConfig, calculatePosition, translationConfig, dictionary],
  );

  const [pos, setPos] = useState(() => calculatePosition());
  const posRef = useRef(pos);
  posRef.current = pos;

  // Update position when content changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: content height changes after loading/translation updates.
  useEffect(() => {
    setPos(calculatePosition());
  }, [calculatePosition, translation, loading]);

  // Update position on resize
  useEffect(() => {
    const handleResize = () => setPos(calculatePosition());
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [calculatePosition]);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
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

  // Auto-speak the looked-up word (TTS) when enabled in settings
  useEffect(() => {
    if (!dictionary || !translationConfig.dictionarySpeak) return;
    let cancelled = false;
    const speak = async () => {
      try {
        const { EdgeTTSPlayer, DEFAULT_TTS_CONFIG } = await import("@readany/core/tts");
        if (cancelled) return;
        const player = new EdgeTTSPlayer();
        // English word lookups use an English Edge voice
        await player.speak(text, {
          ...DEFAULT_TTS_CONFIG,
          edgeVoice: "en-US-AriaNeural",
        });
      } catch (err) {
        console.warn("[Speak] failed:", err);
      }
    };
    void speak();
    return () => {
      cancelled = true;
    };
  }, [dictionary, translationConfig.dictionarySpeak, text]);

  // Fetch translation (AI path; skipped on a local dictionary hit or while
  // the local lookup is still settling. For non-AI dictionary methods, AI
  // only runs as fallback when enabled.)
  useEffect(() => {
    // Instant gate via ref (state wouldn't be visible in the same commit)
    if (ecdictCheckingRef.current || ecdictEntry) return;
    if (dictionary && translationConfig.dictionaryMethod !== "ai" && !useDictionaryFallback)
      return;
    void translationRequestKey;
    let cancelled = false;
    setTranslation(null);

    const input = text.split("\n").join(" ").trim();
    const requestKey = `${input}:${targetLang}`;
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
      .catch((err) => console.error("Translation error:", err));

    return () => {
      cancelled = true;
    };
  }, [
    text,
    targetLang,
    translate,
    systemPrompt,
    refreshKey,
    ecdictEntry,
    ecdictChecking,
    ecdictDoneTick,
    useDictionaryFallback,
    translationConfig.dictionaryMethod,
  ]);

  const handleProviderChange = (providerId: TranslatorName, providerName: string) => {
    updateTranslationConfig({
      provider: {
        ...translationConfig.provider,
        id: providerId,
        name: providerName,
      },
    });
    setProviderRevision((revision) => revision + 1);
    setProviderOpen(false);
  };

  const handleCopy = async () => {
    if (translation) {
      await navigator.clipboard.writeText(translation);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Get provider display name — must reflect the model actually used by this
  // popover instance (dictionary mode reads dictionaryModel, normal mode
  // selectionModel), showing the concrete model name rather than the endpoint.
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

  return (
    <div
      ref={containerRef}
      className="fixed z-50"
      style={{
        width: size.width,
        // Never wider than the viewport (narrow windows)
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
        className="relative overflow-hidden rounded-lg border border-border shadow-lg"
        style={{
          height: size.height ?? undefined,
          // Clamp against the viewport so content never escapes the window
          maxHeight: "calc(100vh - 32px)",
          // Explicit theme colors: never let the popover end up with a
          // transparent background (would bleed text onto the page below)
          backgroundColor: "var(--background)",
          color: "var(--foreground)",
        }}
      >
        {/* Resize handle (bottom-right) — ResizeHandle pattern */}
        <div
          className="absolute bottom-0 right-0 z-10 h-3.5 w-3.5 cursor-se-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
          onPointerCancel={handleResizePointerUp}
        >
          <div className="absolute bottom-0.5 right-0.5 h-1.5 w-1.5 border-b-2 border-r-2 border-muted-foreground/40" />
        </div>
        {/* Header: Language selector + Close */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
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
                onClick={() => {
                  setProviderOpen(!providerOpen);
                }}
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

          {/* Refresh: clear this word's cache and re-request (top-right corner).
              Shown while loading too — a stuck request is exactly when you
              want to retry. */}
          {(loading || (!error && translation)) && (
            <button
              type="button"
              title="清除缓存并重新翻译"
              className="flex shrink-0 items-center rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                void clearCache(text).then(() => setRefreshKey((k) => k + 1));
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Translation content */}
        <div className="flex h-full flex-col p-3">
          <div className="min-h-0 flex-1 overflow-y-auto">
          {dictionary && ecdictEntry ? (
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
                <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
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
                  <p className="whitespace-pre-line text-sm leading-relaxed">{translation}</p>
                </>
              )}
            </>
          )}
          </div>
          {/* Bottom row — pinned to the popover bottom, outside the scroll area */}
          {!loading && !error && translation && (
            <div className="flex shrink-0 items-center justify-end gap-2 pt-1">
              <span className="max-w-28 truncate text-[10px] text-muted-foreground">
                {providerName}
              </span>
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3" />
                    <span>{t("common.copied")}</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    <span>{t("common.copy")}</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
