import type { HighlightColor } from "@readany/core/types";
import { HIGHLIGHT_COLORS, HIGHLIGHT_COLOR_HEX } from "@readany/core/types";
import { cn } from "@readany/core/utils";
import {
  Check,
  Copy,
  Headphones,
  Highlighter,
  Languages,
  NotebookPen,
  Sparkles,
  Trash2,
} from "lucide-react";
/**
 * SelectionPopover — popover on text selection with highlight colors
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface SelectionPopoverProps {
  position: { x: number; y: number };
  selectedText: string;
  annotated?: boolean; // true if this is an existing annotation
  currentColor?: HighlightColor; // current highlight color (for existing annotations)
  defaultColor?: HighlightColor;
  showColors?: boolean; // remembered open/closed state
  onToggleColors?: (show: boolean) => void;
  isPdf?: boolean; // true if viewing a PDF (highlight disabled)
  onHighlight: (color: HighlightColor) => void;
  onRemoveHighlight: () => void;
  onNote: () => void;
  onCopy: () => void;
  onTranslate: () => void;
  onAskAI: () => void;
  onSpeak: () => void;
  onClose: () => void;
}

const POPOVER_MARGIN = 8;

export function SelectionPopover({
  position,
  selectedText: _selectedText,
  annotated = false,
  currentColor,
  defaultColor = "yellow",
  showColors: initialShowColors = false,
  onToggleColors,
  isPdf = false,
  onHighlight,
  onRemoveHighlight,
  onNote,
  onCopy,
  onTranslate,
  onAskAI,
  onSpeak,
  onClose: _onClose,
}: SelectionPopoverProps) {
  const { t } = useTranslation();
  const [showColors, setShowColors] = useState(!isPdf && initialShowColors);
  const [selectedColor, setSelectedColor] = useState<HighlightColor | null>(
    currentColor ?? (annotated ? defaultColor : null),
  );
  const overlayRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [clampedPosition, setClampedPosition] = useState(position);

  // Sync showColors when initialShowColors changes externally
  useEffect(() => {
    if (!isPdf) {
      setShowColors(initialShowColors);
    }
  }, [initialShowColors, isPdf]);

  // Keep selectedColor in sync if currentColor/annotated changes externally
  useEffect(() => {
    if (currentColor) {
      setSelectedColor(currentColor);
    } else if (!annotated) {
      setSelectedColor(null);
    }
  }, [currentColor, annotated]);

  // Highlighter button: toggle for the color bar above with memory
  const handleHighlightToggle = () => {
    if (isPdf) return;
    setShowColors((prev) => {
      const next = !prev;
      onToggleColors?.(next);
      return next;
    });
  };

  // Color click: if already this color, toggle off (cancel annotation); otherwise apply this color
  const handleColorSelect = (color: HighlightColor) => {
    if (selectedColor === color) {
      // Clicked the active color again -> cancel/remove highlight
      setSelectedColor(null);
      onRemoveHighlight();
    } else {
      // Clicked a new color -> apply highlight
      setSelectedColor(color);
      onHighlight(color);
    }
  };

  // Dedicated trash can in the color row to remove annotation
  const handleDeleteHighlight = () => {
    setSelectedColor(null);
    onRemoveHighlight();
  };

  const buttons = [
    {
      icon: Highlighter,
      label: isPdf ? t("reader.highlightNotSupportedPdf") : t("reader.highlight"),
      onClick: handleHighlightToggle,
      isHighlight: true,
      disabled: isPdf,
    },
    { icon: NotebookPen, label: t("reader.note"), onClick: onNote, disabled: isPdf },
    { icon: Copy, label: t("common.copy"), onClick: onCopy },
    { icon: Languages, label: t("reader.translate"), onClick: onTranslate },
    { icon: Sparkles, label: t("reader.askAI"), onClick: onAskAI },
    { icon: Headphones, label: t("tts.speakSelection"), onClick: onSpeak },
  ];

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const popover = popoverRef.current;
    if (!overlay || !popover) {
      setClampedPosition(position);
      return;
    }

    const maxX = Math.max(
      POPOVER_MARGIN,
      overlay.clientWidth - popover.offsetWidth - POPOVER_MARGIN,
    );
    const maxY = Math.max(
      POPOVER_MARGIN,
      overlay.clientHeight - popover.offsetHeight - POPOVER_MARGIN,
    );
    const nextPosition = {
      x: Math.min(Math.max(position.x, POPOVER_MARGIN), maxX),
      y: Math.min(Math.max(position.y, POPOVER_MARGIN), maxY),
    };

    setClampedPosition((current) =>
      current.x === nextPosition.x && current.y === nextPosition.y ? current : nextPosition,
    );
  });

  return (
    <div ref={overlayRef} className="absolute inset-0 z-50 pointer-events-none">
      <div
        ref={popoverRef}
        className="absolute z-10 flex flex-col items-center gap-1 pointer-events-auto"
        style={{ left: clampedPosition.x, top: clampedPosition.y }}
      >
        {/* Color picker row + dedicated trash can */}
        {showColors && !isPdf && (
          <div className="flex items-center gap-1 rounded-lg border border-border bg-background p-1.5 shadow-lg">
            {HIGHLIGHT_COLORS.map((color) => (
              <button
                type="button"
                key={color}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full transition-transform hover:scale-110",
                )}
                style={{ backgroundColor: HIGHLIGHT_COLOR_HEX[color] }}
                title={t(`reader.color.${color}`)}
                onClick={() => handleColorSelect(color)}
              >
                {selectedColor === color && (
                  <Check className="h-3.5 w-3.5 text-white drop-shadow-md" />
                )}
              </button>
            ))}

            {/* Separator */}
            <div className="mx-0.5 h-4 w-px bg-border/80" />

            {/* Dedicated trash can to delete highlight */}
            <button
              type="button"
              disabled={!selectedColor && !annotated}
              onClick={handleDeleteHighlight}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full transition-colors",
                selectedColor || annotated
                  ? "text-muted-foreground hover:bg-destructive/15 hover:text-destructive cursor-pointer"
                  : "text-muted-foreground/30 cursor-not-allowed",
              )}
              title={t("notebook.deleteHighlight", "删除高亮")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div className="flex items-center gap-0.5 rounded-lg border border-border bg-background p-1 shadow-lg">
          {buttons.map((btn) => (
            <button
              type="button"
              key={btn.label}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
                btn.disabled ? "cursor-not-allowed opacity-40" : "hover:bg-muted",
                btn.isHighlight && showColors && !isPdf && "bg-muted text-primary",
              )}
              title={btn.label}
              onClick={btn.disabled ? undefined : btn.onClick}
              disabled={btn.disabled}
            >
              <btn.icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
