import { useTranslator } from "@/hooks/useTranslator";
/**
 * TranslationPopover — compact floating popover for translation
 * Robust positioning: always stays within viewport
 */
import { fetchEudicEntry, parseEudicEntry, type EudicEntry } from "@/lib/eudic-lookup";
import { useSettingsStore } from "@/stores/settings-store";
import { buildDictionaryPrompt } from "@readany/core/translation/providers";
import {
  TRANSLATOR_LANGS,
  TRANSLATOR_PROVIDERS,
  type TranslationTargetLang,
  type TranslatorName,
} from "@readany/core/types/translation";
import { BookOpen, Check, ChevronDown, Copy, Languages, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const [targetLang, setTargetLang] = useState<TranslationTargetLang>(translationConfig.targetLang);
  const [translation, setTranslation] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerRevision, setProviderRevision] = useState(0);
  const translationRequestKey = `${targetLang}:${providerRevision}`;

  // Eudic web lookup mode: dictionary method set to "eudic"
  const isEudic = dictionary && translationConfig.dictionaryMethod === "eudic";
  const [eudicState, setEudicState] = useState<{
    loading: boolean;
    entry: EudicEntry | null;
    error: string | null;
  }>({ loading: false, entry: null, error: null });

  // Dictionary mode resolves its own prompt from settings (live targetLang, so
  // switching the language in the popover re-renders the prompt too).
  const systemPrompt = useMemo(() => {
    if (!dictionary) return undefined;
    const p = buildDictionaryPrompt(translationConfig.dictionaryPrompt, "AUTO", targetLang, text);
    console.log("[DictPrompt] word:", text, "prompt:", p.slice(0, 120));
    return p;
  }, [dictionary, translationConfig.dictionaryPrompt, targetLang, text]);

  const { translate, loading, error, provider } = useTranslator({
    targetLang,
    systemPrompt,
    mode: dictionary ? "dictionary" : "selection",
  });

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const langRef = useRef<HTMLDivElement>(null);
  const providerRef = useRef<HTMLDivElement>(null);

  // Resizable size (height null = auto until user drags the resize handle).
  // Restores the last dragged size from settings (persisted).
  const [size, setSize] = useState<{ width: number; height: number | null }>(
    translationConfig.popoverSize ?? { width: POPOVER_WIDTH, height: null },
  );
  const sizeRef = useRef(size);
  sizeRef.current = size;

  // Clamp the current mode's position to the viewport with the latest size,
  // without switching modes — used while the resize handle is being dragged so
  // the popover stays put (no jumping) but never covers the anchor.
  const clampCurrentMode = useCallback(() => {
    const popoverHeight =
      sizeRef.current.height ?? containerRef.current?.offsetHeight ?? POPOVER_MIN_HEIGHT;
    const popoverWidth = sizeRef.current.width;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const anchorTop = position.top ?? position.y;
    const anchorBottom = position.bottom ?? position.y;
    const anchorLeft = position.left ?? position.x;
    const anchorRight = position.right ?? position.x;
    const anchorCenterY = (anchorTop + anchorBottom) / 2;

    const mode = posRef.current.mode;
    let x: number;
    let y: number;
    if (mode === "above") {
      x = Math.max(
        popoverWidth / 2 + PADDING,
        Math.min(position.x, vw - popoverWidth / 2 - PADDING),
      );
      y = anchorTop - GAP;
    } else if (mode === "below") {
      x = Math.max(
        popoverWidth / 2 + PADDING,
        Math.min(position.x, vw - popoverWidth / 2 - PADDING),
      );
      y = anchorBottom + GAP;
    } else if (mode === "right") {
      x = anchorRight + GAP;
      y = Math.max(
        PADDING + popoverHeight / 2,
        Math.min(anchorCenterY, vh - popoverHeight / 2 - PADDING),
      );
    } else {
      x = anchorLeft - GAP - popoverWidth;
      y = Math.max(
        PADDING + popoverHeight / 2,
        Math.min(anchorCenterY, vh - popoverHeight / 2 - PADDING),
      );
    }
    return { x, y, mode };
  }, [position]);

  // Drag-to-resize: bottom-right handle; final size is persisted to settings
  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = sizeRef.current.width;
      const startH =
        sizeRef.current.height ?? containerRef.current?.offsetHeight ?? POPOVER_MIN_HEIGHT;
      const onMove = (ev: PointerEvent) => {
        const w = Math.max(POPOVER_MIN_WIDTH, startW + (ev.clientX - startX));
        const h = Math.max(POPOVER_MIN_HEIGHT, startH + (ev.clientY - startY));
        setSize({
          width: Math.min(w, window.innerWidth - PADDING * 2),
          height: Math.min(h, window.innerHeight - PADDING * 2),
        });
        // Keep the popover anchored while resizing (no mode switching mid-drag)
        setPos(clampCurrentMode());
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        // Remember the dragged size for next time
        updateTranslationConfig({
          popoverSize: {
            width: sizeRef.current.width,
            height: sizeRef.current.height ?? POPOVER_MIN_HEIGHT,
          },
        });
        // Re-anchor with the final size (kept stable during the drag)
        setPos(calculatePosition());
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [updateTranslationConfig, clampCurrentMode],
  );

  // Position modes: above/below the anchor vertically, right/left when there
  // is no vertical room — never covering the highlighted content. Reads size
  // from the ref so dragging the resize handle doesn't re-position the popover
  // mid-drag (it re-anchors once on pointer up).
  const calculatePosition = useCallback(() => {
    const popoverHeight = sizeRef.current.height ?? Math.min(
      containerRef.current?.offsetHeight || POPOVER_MIN_HEIGHT,
      POPOVER_MAX_HEIGHT,
    );
    const popoverWidth = sizeRef.current.width;
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

    if (spaceAbove >= popoverHeight) {
      mode = "above";
      x = position.x;
      y = anchorTop - GAP;
    } else if (spaceBelow >= popoverHeight) {
      mode = "below";
      x = position.x;
      y = anchorBottom + GAP;
    } else if (spaceRight >= popoverWidth) {
      // No vertical room → place to the right of the anchor
      mode = "right";
      x = anchorRight + GAP;
      y = anchorCenterY;
    } else if (spaceLeft >= popoverWidth) {
      // No vertical room and no right room → place to the left
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

    // Horizontal clamp (vertical modes center on position.x)
    if (mode === "above" || mode === "below") {
      const halfWidth = popoverWidth / 2;
      x = Math.max(halfWidth + PADDING, Math.min(x, viewportWidth - halfWidth - PADDING));
    } else {
      // Vertical clamp (right/left modes center vertically on the anchor)
      y = Math.max(
        PADDING + popoverHeight / 2,
        Math.min(y, viewportHeight - popoverHeight / 2 - PADDING),
      );
    }

    return { x, y, mode };
  }, [position]);

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

  // Fetch translation (AI path; skipped in Eudic mode)
  useEffect(() => {
    if (isEudic) return;
    void translationRequestKey;
    let cancelled = false;
    setTranslation(null);

    const fetch = async () => {
      try {
        const input = text.split("\n").join(" ").trim();
        const results = await translate([input]);
        if (!cancelled && results[0]) {
          setTranslation(results[0]);
        }
      } catch (err) {
        console.error("Translation error:", err);
      }
    };

    fetch();
    return () => {
      cancelled = true;
    };
  }, [text, translationRequestKey, translate, systemPrompt, isEudic]);

  // Eudic web lookup first; when the entry is unusable (empty/partial senses —
  // Eudic serves many definitions as anti-scrape images — or network failure),
  // fall back to AI translation in the same popover (unless disabled).
  const useEudicFallback = translationConfig.eudicFallback !== false;
  useEffect(() => {
    if (!isEudic) return;
    let cancelled = false;
    setEudicState({ loading: true, entry: null, error: null });

    const run = async () => {
      let usable = false;
      try {
        const html = await fetchEudicEntry(text);
        if (cancelled) return;
        const entry = parseEudicEntry(html);
        console.log(
          "[EudicLookup] word:",
          text,
          "htmlLen:",
          html.length,
          "phonetic:",
          entry.phonetic,
          "senses:",
          JSON.stringify(entry.senses.slice(0, 5)),
        );
        usable =
          entry.senses.length > 0 && entry.senses.join("").replace(/\s/g, "").length >= 12;
        if (cancelled) return;
        setEudicState({ loading: false, entry: usable ? entry : null, error: null });
      } catch (err) {
        console.log("[EudicLookup] error:", err instanceof Error ? err.message : String(err));
        if (!cancelled) {
          setEudicState({ loading: false, entry: null, error: null });
        }
      }
      // Fall back to AI translation when the Eudic entry is unusable
      if (!usable && useEudicFallback && !cancelled) {
        console.log("[EudicLookup] falling back to AI for:", text);
        try {
          const input = text.split("\n").join(" ").trim();
          const results = await translate([input]);
          if (!cancelled && results[0]) {
            setTranslation(results[0]);
          }
        } catch (err) {
          console.error("Translation error:", err);
        }
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [isEudic, text, translate, useEudicFallback]);

  const handleLangChange = (lang: TranslationTargetLang) => {
    setTargetLang(lang);
    updateTranslationConfig({ targetLang: lang });
    setLangOpen(false);
  };

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

  return createPortal(
    <div
      ref={containerRef}
      className="fixed z-[9999]"
      style={{
        width: size.width,
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
        className="relative rounded-lg border border-border bg-background shadow-lg"
        style={{ height: size.height ?? undefined }}
      >
        {/* Resize handle (bottom-right) */}
        <div
          className="absolute bottom-0 right-0 z-10 h-3.5 w-3.5 cursor-se-resize"
          onPointerDown={startResize}
        >
          <div className="absolute bottom-0.5 right-0.5 h-1.5 w-1.5 border-b-2 border-r-2 border-muted-foreground/40" />
        </div>
        {/* Header: Language selector + Close */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            {isEudic && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <BookOpen className="h-3.5 w-3.5" />
                <span>{t("settings.dictionaryMethodEudic")}</span>
              </span>
            )}
            {!isEudic && (
            <>
            <div className="relative" ref={langRef}>
              <button
                type="button"
                onClick={() => {
                  setProviderOpen(false);
                  setLangOpen(!langOpen);
                }}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Languages className="h-3.5 w-3.5" />
                <span>{TRANSLATOR_LANGS[targetLang]}</span>
                <ChevronDown className="h-3 w-3" />
              </button>

              {langOpen && (
                <div className="absolute left-0 top-full z-50 mt-1 w-36 rounded-md border bg-background p-1 shadow-lg">
                  <div className="max-h-48 overflow-y-auto">
                    {Object.entries(TRANSLATOR_LANGS).map(([code, name]) => (
                      <button
                        key={code}
                        type="button"
                        onClick={() => handleLangChange(code as TranslationTargetLang)}
                        className={`flex w-full items-center justify-between rounded-sm px-2 py-1 text-left text-xs ${
                          code === targetLang ? "bg-primary/10 text-primary" : "hover:bg-muted"
                        }`}
                      >
                        <span>{name}</span>
                        {code === targetLang && <Check className="h-3 w-3" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="relative min-w-0" ref={providerRef}>
              <button
                type="button"
                onClick={() => {
                  setLangOpen(false);
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
            </>
            )}
          </div>

        </div>

        {/* Translation content */}
        <div className="max-h-full overflow-y-auto p-3">
          {isEudic ? (
            <>
              {eudicState.loading && (
                <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{t("translation.eudicLoading")}</span>
                </div>
              )}

              {eudicState.entry && !eudicState.loading && (
                <div className="max-h-40 space-y-1.5 overflow-y-auto">
                  {eudicState.entry.phonetic && (
                    <div className="text-xs text-muted-foreground">
                      {eudicState.entry.phonetic}
                    </div>
                  )}
                  {eudicState.entry.senses.map((sense, i) => (
                    <div key={i} className="text-sm leading-relaxed">
                      {sense}
                    </div>
                  ))}
                  {eudicState.entry.examples.map((ex, i) => (
                    <div key={`ex-${i}`} className="text-xs leading-relaxed text-muted-foreground">
                      {ex}
                    </div>
                  ))}
                </div>
              )}

              {/* Eudic unusable (image senses / network failure) */}
              {!eudicState.loading && !eudicState.entry && (
                useEudicFallback ? (
                  <>
                    <div className="pb-1 text-[10px] text-muted-foreground">
                      {t("translation.eudicFallbackHint")}
                    </div>
                    {loading && (
                      <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>{t("translation.translating")}</span>
                      </div>
                    )}
                    {error && !loading && (
                      <div className="py-1 text-sm text-destructive">{error}</div>
                    )}
                    {!loading && !error && translation && (
                      <p className="max-h-32 overflow-y-auto whitespace-pre-line text-sm leading-relaxed">
                        {translation}
                      </p>
                    )}
                  </>
                ) : (
                  <div className="space-y-2 py-1">
                    <div className="text-sm text-muted-foreground">
                      {t("translation.eudicNotFound")}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        window.open(
                          `https://dict.eudic.net/dicts/en/${encodeURIComponent(text)}`,
                          "_blank",
                        )
                      }
                      className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                    >
                      {t("translation.eudicOpenInBrowser")}
                    </button>
                  </div>
                )
              )}
            </>
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
                  <p className="max-h-32 overflow-y-auto whitespace-pre-line text-sm leading-relaxed">
                    {translation}
                  </p>
                  <div className="flex items-center justify-end gap-2 pt-1">
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
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
