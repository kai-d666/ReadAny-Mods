import {
  BookOpenIcon,
  CopyIcon,
  SparklesIcon,
  Volume2Icon,
} from "@/components/ui/Icon";
import type { SelectionEvent } from "@/hooks/use-reader-bridge";
import { radius, spacing, useColors, withOpacity } from "@/styles/theme";
import type { ThemeColors } from "@/styles/theme";
import * as Clipboard from "expo-clipboard";
/**
 * SelectionPopover — floating action bar shown when text is selected in the reader.
 * 精简版:仅保留 复制 / AI 对话 / 发音 / 词典(欧路小窗)。
 * 高亮、笔记、翻译按钮已按用户要求移除(词典按钮对长句由欧路自动整句翻译)。
 */
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";

const POPOVER_MARGIN = 8;
const POPOVER_PADDING = 5;
const BUTTON_SIZE = 45; // 36 × 1.25
const BUTTON_ICON_SIZE = 22; // 18 × 1.25
const GAP = 3;
const SAFE_TOP = 14;
const SAFE_BOTTOM = 20;
const SELECTION_POPOVER_ABOVE_OFFSET = 4;
const SELECTION_POPOVER_BELOW_OFFSET = 6;

interface Props {
  selection: SelectionEvent;
  onDismiss: () => void;
  onCopy: () => void;
  onAIChat: () => void;
  onSpeak?: (text: string, cfi: string) => void;
  /** 唤起外部词典(欧路小窗)查词/整句翻译 */
  onDictionary?: (text: string) => void;
}

export function SelectionPopover({
  selection,
  onDismiss,
  onCopy,
  onAIChat,
  onSpeak,
  onDictionary,
}: Props) {
  const { t } = useTranslation();
  const colors = useColors();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const s = useMemo(() => makeStyles(colors), [colors]);

  const buttonCount = 2 + (onSpeak ? 1 : 0) + (onDictionary ? 1 : 0);
  const actionRowWidth = buttonCount * (BUTTON_SIZE + GAP) + POPOVER_PADDING * 2;
  const actionRowHeight = 55; // 44 × 1.25
  const popoverHeight = actionRowHeight + POPOVER_PADDING * 2;
  const popoverWidth = Math.min(actionRowWidth, screenWidth - POPOVER_MARGIN * 2);

  const position = useMemo(() => {
    const selTop = selection.position.selectionTop;
    const selBottom = selection.position.selectionBottom;
    const selCenterX = selection.position.x;

    const x = Math.max(
      POPOVER_MARGIN,
      Math.min(selCenterX - popoverWidth / 2, screenWidth - popoverWidth - POPOVER_MARGIN),
    );

    let y: number;
    const yAbove = selTop - popoverHeight + SELECTION_POPOVER_ABOVE_OFFSET;
    const yBelow = selBottom + SELECTION_POPOVER_BELOW_OFFSET;
    const aboveValid = yAbove >= SAFE_TOP;
    const belowValid = yBelow + popoverHeight + POPOVER_MARGIN <= screenHeight - SAFE_BOTTOM;
    const maxY = Math.max(SAFE_TOP, screenHeight - popoverHeight - SAFE_BOTTOM);

    if (aboveValid) {
      y = yAbove;
    } else if (belowValid) {
      y = yBelow;
    } else {
      y = Math.max(SAFE_TOP, Math.min(yBelow, maxY));
    }

    return { x, y };
  }, [screenHeight, screenWidth, selection.position, popoverWidth, popoverHeight]);

  const handleCopy = useCallback(() => {
    Clipboard.setStringAsync(selection.text);
    onCopy();
  }, [selection.text, onCopy]);

  const handleSpeak = useCallback(() => {
    const text = selection.text.trim();
    if (text && onSpeak) {
      onSpeak(text, selection.cfi);
    }
    onDismiss();
  }, [selection.text, selection.cfi, onSpeak, onDismiss]);

  const handleDictionary = useCallback(() => {
    if (onDictionary) {
      onDictionary(selection.text);
    }
    onDismiss();
  }, [selection.text, onDictionary, onDismiss]);

  return (
    <View style={[s.overlay]} pointerEvents="box-none">
      <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onDismiss} />
      <View style={[s.popover, { left: position.x, top: position.y }]}>
        <View style={s.actionRow}>
          <TouchableOpacity style={s.iconBtn} onPress={handleCopy}>
            <CopyIcon size={BUTTON_ICON_SIZE} color={colors.foreground} />
          </TouchableOpacity>

          <TouchableOpacity style={s.iconBtn} onPress={onAIChat}>
            <SparklesIcon size={BUTTON_ICON_SIZE} color={colors.foreground} />
          </TouchableOpacity>

          {onDictionary && (
            <TouchableOpacity
              style={s.iconBtn}
              onPress={handleDictionary}
              accessibilityRole="button"
              accessibilityLabel="词典查词"
            >
              <BookOpenIcon size={BUTTON_ICON_SIZE} color={colors.foreground} />
            </TouchableOpacity>
          )}

          {onSpeak && (
            <TouchableOpacity style={s.iconBtn} onPress={handleSpeak}>
              <Volume2Icon size={BUTTON_ICON_SIZE} color={colors.foreground} />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 100,
    },
    popover: {
      position: "absolute",
      backgroundColor: colors.card,
      borderRadius: radius.xl,
      padding: POPOVER_PADDING,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.25,
      shadowRadius: 12,
      elevation: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    actionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: GAP,
    },
    iconBtn: {
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
      borderRadius: radius.lg,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: withOpacity(colors.foreground, 0.04),
    },
  });
