import {
  BrainIcon,
  ChevronDownIcon,
  EyeOffIcon,
  SendIcon,
  StopCircleIcon,
  XIcon,
} from "@/components/ui/Icon";
import { useKeyboardInsets } from "@/hooks/use-keyboard-insets";
import { useSettingsStore } from "@/stores/settings-store";
import { fontSize as fs, radius, useColors, withOpacity } from "@/styles/theme";
import type { ThemeColors } from "@/styles/theme";
import type { AttachedQuote } from "@readany/core/types";
/**
 * ChatInput — touch-optimized chat input matching app-mobile MobileChatInput.
 * Rounded container with textarea on top, action bar (deep thinking + send) below.
 */
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  type TextInputContentSizeChangeEvent,
  TouchableOpacity,
  View,
} from "react-native";

interface ChatInputProps {
  onSend: (
    text: string,
    deepThinking: boolean,
    spoilerFree: boolean,
    quotes?: AttachedQuote[],
  ) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  quotes?: AttachedQuote[];
  onRemoveQuote?: (id: string) => void;
  placeholder?: string;
  keyboardBottomOffset?: number;
  /** 聊天上下文,决定防剧透开关读写 aiConfig.spoilerFree 的哪个场景(全局聊天/书内聊天) */
  variant?: "general" | "book";
}

const SINGLE_LINE_INPUT_HEIGHT = 46;
const MAX_INPUT_HEIGHT = 112;
const INPUT_PADDING_VERTICAL = 16;

export function ChatInput({
  onSend,
  onStop,
  isStreaming,
  quotes = [],
  onRemoveQuote,
  placeholder,
  keyboardBottomOffset = 0,
  variant = "general",
}: ChatInputProps) {
  const [text, setText] = useState("");
  const [deepThinking, setDeepThinking] = useState(false);
  const [inputHeight, setInputHeight] = useState(SINGLE_LINE_INPUT_HEIGHT);
  const { t } = useTranslation();
  const colors = useColors();
  const s = makeStyles(colors);
  const inputRef = useRef<TextInput>(null);
  const keyboardInsets = useKeyboardInsets();
  const effectiveKeyboardBottomOffset = keyboardBottomOffset ?? keyboardInsets.safeAreaBottom;
  // 实测修正:vivo 上 ime insets 比键盘画面实际渲染高,两个页面底部遮挡不同,分开校准:
  // - 底栏 AI 助手(ChatScreen):tab bar 上方,实测 47dp
  // - 书内 AI 助手(BookChatScreen):三键导航栏上方,实测 -13dp
  // 换输入法/ROM 后若再留空或遮挡,调整此值。
  const ANDROID_KEYBOARD_HEIGHT_FUDGE = variant === "book" ? -13 : 47;
  const visibleKeyboardPadding =
    Platform.OS === "ios"
      ? Math.max(8, keyboardInsets.rawHeight - effectiveKeyboardBottomOffset + 14)
      : // Android(RN 0.81 edge-to-edge):键盘弹出时窗口不再 resize(实测窗口 frame 不变),
        // 只能靠键盘实际高度把输入栏顶起,并减去 ime insets 的虚高(紧贴键盘,不留余量)
        Math.max(8, keyboardInsets.rawHeight - ANDROID_KEYBOARD_HEIGHT_FUDGE);
  const bottomPadding = keyboardInsets.isVisible
    ? visibleKeyboardPadding
    : Math.max(4, Math.min(keyboardInsets.safeAreaBottom, 8));

  // 防剧透开关按聊天上下文(general/book)持久记忆,发送后不重置(移植自桌面 ea0bd55)
  const aiConfig = useSettingsStore((st) => st.aiConfig);
  const updateAIConfig = useSettingsStore((st) => st.updateAIConfig);
  const spoilerFree = aiConfig.spoilerFree[variant];

  const handleToggleSpoilerFree = useCallback(() => {
    updateAIConfig({
      spoilerFree: { ...aiConfig.spoilerFree, [variant]: !aiConfig.spoilerFree[variant] },
    });
  }, [aiConfig.spoilerFree, variant, updateAIConfig]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && quotes.length === 0) return;
    onSend(trimmed, deepThinking, spoilerFree, quotes.length > 0 ? quotes : undefined);
    setInputHeight(SINGLE_LINE_INPUT_HEIGHT);
    setText("");
    setDeepThinking(false);
  }, [text, deepThinking, spoilerFree, quotes, onSend]);

  const handleTextChange = useCallback((nextText: string) => {
    setText(nextText);
    if (!nextText) {
      setInputHeight(SINGLE_LINE_INPUT_HEIGHT);
    }
  }, []);

  const handleContentSizeChange = useCallback(
    (e: TextInputContentSizeChangeEvent) => {
      if (!text) {
        setInputHeight(SINGLE_LINE_INPUT_HEIGHT);
        return;
      }
      const contentHeight = e.nativeEvent.contentSize.height;
      const totalHeight = contentHeight + INPUT_PADDING_VERTICAL;
      const h = Math.min(totalHeight, MAX_INPUT_HEIGHT);
      setInputHeight(Math.max(SINGLE_LINE_INPUT_HEIGHT, h));
    },
    [text],
  );

  const canSend = text.trim().length > 0 || quotes.length > 0;

  return (
    <View style={[s.wrapper, { paddingBottom: bottomPadding }]}>
      <View style={s.container}>
        {/* Attached quotes chips */}
        {quotes.length > 0 && (
          <View style={s.quotesRow}>
            {quotes.map((q) => (
              <View key={q.id} style={s.quoteChip}>
                <Text style={s.quoteChipText} numberOfLines={1}>
                  {q.text.slice(0, 40)}
                </Text>
                <TouchableOpacity
                  onPress={() => onRemoveQuote?.(q.id)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <XIcon size={10} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* Input area */}
        <TextInput
          ref={inputRef}
          style={[s.input, { height: inputHeight }]}
          placeholder={
            quotes.length > 0
              ? t("chat.askAboutQuote", "关于引用提问...")
              : placeholder || t("chat.inputPlaceholder", "输入消息...")
          }
          placeholderTextColor={colors.mutedForeground}
          value={text}
          onChangeText={handleTextChange}
          multiline
          onContentSizeChange={handleContentSizeChange}
          returnKeyType="default"
          blurOnSubmit={false}
          editable={!isStreaming}
        />

        {/* Action bar: deep thinking toggle + spoiler-free toggle + send */}
        <View style={s.actionBar}>
          <View style={s.toggleRow}>
            <TouchableOpacity
              style={[s.deepThinkBtn, deepThinking && s.deepThinkBtnActive]}
              onPress={() => setDeepThinking(!deepThinking)}
              activeOpacity={0.7}
            >
              <BrainIcon size={13} color={deepThinking ? colors.primary : colors.mutedForeground} />
              <Text style={[s.deepThinkText, deepThinking && s.deepThinkTextActive]}>
                {t("chat.deepThinking", "深度思考")}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.deepThinkBtn, spoilerFree && s.deepThinkBtnActive]}
              onPress={handleToggleSpoilerFree}
              activeOpacity={0.7}
            >
              <EyeOffIcon size={13} color={spoilerFree ? colors.primary : colors.mutedForeground} />
              <Text style={[s.deepThinkText, spoilerFree && s.deepThinkTextActive]}>
                {t("chat.spoilerFree", "防剧透")}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={s.actionButtons}>
            {keyboardInsets.isVisible && (
              <TouchableOpacity
                style={s.sendBtn}
                onPress={Keyboard.dismiss}
                activeOpacity={0.7}
                accessibilityLabel={t("chat.dismissKeyboard", "收起键盘")}
              >
                <ChevronDownIcon size={15} color={colors.mutedForeground} />
              </TouchableOpacity>
            )}

            {isStreaming ? (
              <TouchableOpacity style={s.sendBtn} onPress={onStop} activeOpacity={0.7}>
                <StopCircleIcon size={16} color={colors.destructive} />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[s.sendBtn, canSend && s.sendBtnActive]}
                onPress={handleSend}
                disabled={!canSend}
                activeOpacity={0.7}
              >
                <SendIcon
                  size={14}
                  color={canSend ? colors.primaryForeground : colors.mutedForeground}
                />
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
      {deepThinking && (
        <Text style={s.deepThinkHint}>
          {t("chat.deepThinkingHint", "深度思考模式会使用更多 tokens")}
        </Text>
      )}
      {spoilerFree && (
        <Text style={s.deepThinkHint}>
          {t("chat.spoilerFreeHint", "AI 将避免透露当前阅读进度之后的内容")}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrapper: {
      paddingHorizontal: 12,
      paddingTop: 4,
      paddingBottom: 4,
    },
    container: {
      borderRadius: radius.xl + 4,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      shadowColor: colors.foreground,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.08,
      shadowRadius: 6,
      elevation: 2,
    },
    quotesRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
      paddingHorizontal: 12,
      paddingTop: 10,
    },
    quoteChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: "rgba(99,102,241,0.06)",
      borderWidth: 0.5,
      borderColor: "rgba(99,102,241,0.2)",
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: radius.md,
      flex: 1,
    },
    quoteChipText: {
      fontSize: fs.xs,
      color: colors.primary,
      flex: 1,
    },
    input: {
      fontSize: fs.sm,
      color: colors.foreground,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 6,
      minHeight: SINGLE_LINE_INPUT_HEIGHT,
      maxHeight: MAX_INPUT_HEIGHT,
      lineHeight: 20,
      textAlignVertical: "top",
    },
    actionBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 12,
      paddingBottom: 9,
      minHeight: 36,
    },
    toggleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      flexShrink: 1,
    },
    actionButtons: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginLeft: 8,
    },
    deepThinkBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    deepThinkBtnActive: {
      borderColor: withOpacity(colors.primary, 0.5),
      backgroundColor: withOpacity(colors.primary, 0.1),
    },
    deepThinkText: {
      fontSize: fs.xs,
      color: colors.mutedForeground,
    },
    deepThinkTextActive: {
      color: colors.primary,
    },
    sendBtn: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
    },
    sendBtnActive: {
      borderColor: withOpacity(colors.primary, 0.35),
      backgroundColor: colors.primary,
    },
    deepThinkHint: {
      fontSize: fs.xs,
      color: colors.mutedForeground,
      textAlign: "center",
      marginTop: 6,
    },
  });
