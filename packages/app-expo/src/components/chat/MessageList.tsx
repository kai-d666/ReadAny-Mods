import { CheckIcon, ChevronDownIcon, CopyIcon } from "@/components/ui/Icon";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { fontSize as fs, radius, useColors, withOpacity } from "@/styles/theme";
import type { ThemeColors } from "@/styles/theme";
import type { CitationPart, MessageV2, QuotePart, TextPart } from "@readany/core/types/message";
import { computeSessionTokenTotals, formatTurnAndSessionTokens } from "@readany/core/utils";
import * as Clipboard from "expo-clipboard";
/**
 * MessageList — FlatList message renderer matching app-mobile MessageList.
 * Scroll-to-bottom button, streaming gap indicator.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FlatList,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { PartRenderer } from "./PartRenderer";
import { StreamingIndicator } from "./StreamingIndicator";

interface MessageListProps {
  messages: MessageV2[];
  isStreaming?: boolean;
  currentStep?: "thinking" | "tool_calling" | "responding" | "idle";
  onCitationClick?: (citation: CitationPart) => void;
  /** Tap on a quoted text chip — jump to the quote's location in the reader. */
  onQuoteClick?: (text: string, cfi?: string) => void;
}

function sortCitationsByIndex(citations: CitationPart[]): CitationPart[] {
  return citations
    .map((citation, order) => ({ citation, order }))
    .sort((a, b) => {
      const aIndex = a.citation.citationIndex;
      const bIndex = b.citation.citationIndex;
      if (typeof aIndex === "number" && typeof bIndex === "number") return aIndex - bIndex;
      if (typeof aIndex === "number") return -1;
      if (typeof bIndex === "number") return 1;
      return a.order - b.order;
    })
    .map(({ citation }) => citation);
}

export function MessageList({
  messages,
  isStreaming,
  currentStep,
  onCitationClick,
  onQuoteClick,
}: MessageListProps) {
  const { t } = useTranslation();
  const colors = useColors();
  const s = makeStyles(colors);
  // 输入栏恒 absolute 悬浮(不占布局),列表恒留占位:
  // - 容器 paddingBottom 压缩可视区,键盘弹出前后列表尺寸一致,背景不跳变
  // - 内容 paddingBottom 留滚动余量,最后一条消息可滚到输入栏上方
  // - 占位须与输入栏双层结构真实高度(rig≈70dp)匹配:旧值 120 把列表视口压得过高,
  //   底部出现"滚动信息被截断"的隐形裂缝(展开中线位置),2026-09-05 修为 78
  const listBottomPad = Platform.OS === "android" ? 78 : 0;
  const {
    listRef,
    isPinned,
    pinToBottom,
    resetToBottom,
    onScroll,
    onScrollBeginDrag: onStickBeginDrag,
    onScrollEndDrag,
    onContentSizeChange,
    onLayout,
  } = useStickToBottom();

  const lastMsg = messages[messages.length - 1];

  // Running session totals: sessionSums[i] = tokens burned by every assistant
  // turn up to and including messages[i]. Read through a ref rather than passed
  // into renderMessage's deps — the array identity changes on every 160ms
  // streaming publish, which would invalidate MessageBubble's memo and
  // re-render every visible row (see the note on MessageBubble below).
  const sessionSums = useMemo(() => computeSessionTokenTotals(messages), [messages]);
  const sessionSumsRef = useRef<number[]>(sessionSums);
  sessionSumsRef.current = sessionSums;

  // Sending a message means the reader wants to watch the answer.
  useEffect(() => {
    if (isStreaming) pinToBottom();
  }, [isStreaming, pinToBottom]);

  // Switching conversations must not inherit the previous one's scroll position
  // (the first message is the thread's system card, so its id identifies the thread).
  const firstMessageId = messages[0]?.id;
  useEffect(() => {
    resetToBottom();
  }, [firstMessageId, resetToBottom]);

  const handleScrollBeginDrag = useCallback(() => {
    Keyboard.dismiss();
    onStickBeginDrag();
  }, [onStickBeginDrag]);

  const handleScrollToBottom = useCallback(() => {
    resetToBottom(true);
  }, [resetToBottom]);

  const [selectModalText, setSelectModalText] = useState<string | null>(null);
  const handleBubbleLongPress = useCallback((text: string) => {
    setSelectModalText(text);
  }, []);

  const renderMessage = useCallback(
    ({ item, index }: { item: MessageV2; index: number }) => {
      const isLastMsg = index === messages.length - 1;
      const isLastMsgStreaming =
        isStreaming && isLastMsg && item.role === "assistant" && item.parts.length > 0;

      return (
        <MessageBubble
          message={item}
          sessionSum={sessionSumsRef.current[index] ?? 0}
          colors={colors}
          isStreaming={isLastMsgStreaming}
          currentStep={currentStep}
          onCitationClick={onCitationClick}
          onQuoteClick={onQuoteClick}
          onLongPress={handleBubbleLongPress}
        />
      );
    },
    [
      colors,
      messages.length,
      isStreaming,
      currentStep,
      onCitationClick,
      onQuoteClick,
      handleBubbleLongPress,
    ],
  );

  // Show indicator when streaming but no assistant content yet
  const showStreamingIndicator =
    isStreaming &&
    currentStep &&
    currentStep !== "idle" &&
    (!lastMsg || lastMsg.role !== "assistant" || lastMsg.parts.length === 0);

  return (
    // 键盘弹出时容器 paddingBottom 压缩可视区,高度与键盘弹出前(输入栏占位)一致,背景不跳变
    <View style={[s.container, { paddingBottom: listBottomPad }]} onTouchStart={Keyboard.dismiss}>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={renderMessage}
        contentContainerStyle={[s.listContent, { paddingBottom: listBottomPad }]}
        // Content growth (streaming deltas, indicators appearing) and viewport
        // changes (keyboard) are the two things that can push the bottom away.
        // Following is gated on the reader still wanting it — see the hook.
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
        onLayout={onLayout}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={onScrollEndDrag}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        // 首挂窗口调小:切入会话时一次性 mount 的原生节点数决定 completeRoot
        // 时长(CDP 采样:切会话两大块 1.1s/0.6s)。initialNumToRender 只控
        // 首批;windowSize 默认 21 仍会挂齐 21 条——必须一并收窄。
        removeClippedSubviews
        initialNumToRender={6}
        maxToRenderPerBatch={4}
        updateCellsBatchingPeriod={80}
        windowSize={7}
        bounces={true}
        bouncesZoom={false}
        ListFooterComponent={
          showStreamingIndicator && currentStep ? <StreamingIndicator step={currentStep} /> : null
        }
      />

      {/* Scroll to bottom button — only while the reader has scrolled away. */}
      {!isPinned && (
        // Android 输入栏为悬浮层(absolute),底部 listBottomPad 是它的占位区,
        // 按钮需抬到占位区之上(86),否则被输入卡盖住;iOS 输入栏为流式占位,8 即合理
        <View style={[s.scrollDownWrap, { bottom: listBottomPad + 8 }]}>
          <TouchableOpacity
            style={s.scrollDownBtn}
            onPress={handleScrollToBottom}
            activeOpacity={0.8}
          >
            <ChevronDownIcon size={14} color={colors.mutedForeground} />
            <Text style={s.scrollDownText}>{t("streaming.scrollToBottom", "滚动到底部")}</Text>
          </TouchableOpacity>
        </View>
      )}

      <SelectableTextModal
        text={selectModalText}
        colors={colors}
        onClose={() => setSelectModalText(null)}
      />
    </View>
  );
}

function UserQuoteBlock({
  part,
  colors,
  onPress,
}: {
  part: QuotePart;
  colors: ThemeColors;
  onPress?: () => void;
}) {
  const styles = quoteStyles(colors);
  const content = (
    <>
      {/* Intrinsic-width column: the bubble's maxWidth (85%) caps the card,
          numberOfLines=1 truncates the tail — so the card follows window/
          bubble width instead of being compressed to a sliver. */}
      <View style={styles.quoteTextWrap}>
        <Text style={styles.quoteText} numberOfLines={1} ellipsizeMode="tail">
          {part.text}
        </Text>
        {part.source && <Text style={styles.quoteSource}>— {part.source}</Text>}
      </View>
      {onPress && part.cfi && (
        <Text style={styles.quoteJump} aria-label="跳转到原文">
          ↗
        </Text>
      )}
    </>
  );

  // Tappable only when it can locate the quote in the reader (cfi present)
  if (onPress && part.cfi) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [styles.quoteBlock, pressed && styles.quoteBlockPressed]}>
        {content}
      </Pressable>
    );
  }
  return <View style={styles.quoteBlock}>{content}</View>;
}

const quoteStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    quoteBlock: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      flexShrink: 1,
      maxWidth: "100%",
      borderRadius: radius.md,
      backgroundColor: withOpacity(colors.primary, 0.05),
      borderWidth: 0.5,
      borderColor: withOpacity(colors.primary, 0.15),
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    quoteTextWrap: {
      flexShrink: 1,
      minWidth: 0,
    },
    quoteText: {
      fontSize: fs.xs,
      lineHeight: 16,
      color: colors.foreground,
      opacity: 0.8,
    },
    quoteSource: {
      fontSize: fs.xs - 1,
      color: colors.mutedForeground,
      marginTop: 2,
    },
    quoteJump: {
      fontSize: fs.sm,
      color: colors.primary,
      alignSelf: "center",
    },
    quoteBlockPressed: {
      opacity: 0.6,
    },
  });

interface MessageBubbleProps {
  message: MessageV2;
  /** Running total of assistant tokens up to and including this message. */
  sessionSum?: number;
  colors: ThemeColors;
  isStreaming?: boolean;
  currentStep?: "thinking" | "tool_calling" | "responding" | "idle";
  onCitationClick?: (citation: CitationPart) => void;
  onQuoteClick?: (text: string, cfi?: string) => void;
  onLongPress?: (text: string) => void;
}

function extractPlainText(message: MessageV2): string {
  const parts: string[] = [];
  for (const p of message.parts) {
    if (p.type === "quote") {
      const q = p as QuotePart;
      if (q.text) parts.push(`> ${q.text}`);
    } else if (p.type === "text") {
      const t = p as TextPart;
      if (t.text.trim()) parts.push(t.text);
    } else if (p.type === "reasoning") {
      const r = p as { reasoning?: string };
      if (r.reasoning?.trim()) parts.push(r.reasoning);
    }
  }
  return parts.join("\n\n");
}

// memo:流式发布期间 FlatList 十个可见行都会重渲染,未变化消息(引用稳定,
// 见 mergeMessagesWithStreaming)必须整体跳过,只有最后一条真正重建。
const MessageBubble = memo(function MessageBubble({
  message,
  sessionSum,
  colors,
  isStreaming,
  currentStep,
  onCitationClick,
  onQuoteClick,
  onLongPress,
}: MessageBubbleProps) {
  const { t } = useTranslation();
  const s = makeStyles(colors);

  // Extract citations from message parts
  const citations = useMemo(() => {
    return sortCitationsByIndex(
      message.parts.filter((p): p is CitationPart => p.type === "citation"),
    );
  }, [message.parts]);

  const triggerLongPress = useCallback(() => {
    if (!onLongPress) return;
    const text = extractPlainText(message);
    if (text) onLongPress(text);
  }, [message, onLongPress]);

  // This turn's cost, recorded by the streaming hook. Not derived from the
  // part badges: those answer different questions per part type (a reasoning
  // card shows the thinking itself, a tool card its round trip) and one LLM
  // call can produce several, so summing them double-counts.
  const turnTokens = message.totalTokens ?? 0;

  // First-turn book info (static title/author/language/description/subjects).
  // Rendered as a context card, not a chat bubble.
  if (message.role === "system") {
    const text = message.parts.find((p) => p.type === "text") as TextPart | undefined;
    return (
      <View style={s.systemRow}>
        <View style={s.systemCard}>
          <Text style={s.systemCardLabel}>{t("chatThreadContext", "会话上下文")}</Text>
          <Text style={s.systemCardText}>{text?.text ?? ""}</Text>
        </View>
      </View>
    );
  }

  if (message.role === "user") {
    const quoteParts = message.parts.filter((p) => p.type === "quote") as QuotePart[];
    const textParts = message.parts.filter((p) => p.type === "text") as TextPart[];

    return (
      <View style={s.userRow}>
        <Pressable style={s.userBubble} onLongPress={triggerLongPress} delayLongPress={300}>
          {quoteParts.length > 0 && (
            <View style={{ gap: 4, marginBottom: textParts.length > 0 ? 6 : 0 }}>
              {quoteParts.map((q) => (
                <UserQuoteBlock
                  key={q.id}
                  part={q}
                  colors={colors}
                  onPress={
                    onQuoteClick ? () => onQuoteClick(q.text, q.cfi) : undefined
                  }
                />
              ))}
            </View>
          )}
          {textParts.map((part) => (
            <Text key={part.id} style={s.userText}>
              {part.text}
            </Text>
          ))}
        </Pressable>
      </View>
    );
  }

  // Assistant message
  const hasContent = message.parts.some(
    (p) => (p.type === "text" && (p as TextPart).text.trim()) || p.type !== "text",
  );
  if (!hasContent) return null;

  const copyText = () => {
    const text = message.parts
      .filter((p) => p.type === "text" && (p as TextPart).text.trim())
      .map((p) => (p as TextPart).text)
      .join("\n\n");
    if (text) Clipboard.setStringAsync(text);
  };

  // Show gap indicator between parts when streaming
  const lastPart = message.parts[message.parts.length - 1];
  const isLastPartRunningText = lastPart?.type === "text" && lastPart.status === "running";
  const isLastPartActiveToolCall =
    lastPart?.type === "tool_call" &&
    (lastPart.status === "pending" || lastPart.status === "running");
  const isLastPartRunningReasoning =
    lastPart?.type === "reasoning" && lastPart.status === "running";
  const showGapIndicator =
    isStreaming &&
    currentStep !== "idle" &&
    lastPart &&
    !isLastPartRunningText &&
    !isLastPartActiveToolCall &&
    !isLastPartRunningReasoning;

  return (
    <View style={s.assistantRow}>
      <Pressable onLongPress={triggerLongPress} delayLongPress={300}>
        {message.parts.map((part) => (
          <PartRenderer
            key={part.id}
            part={part}
            citations={citations}
            onCitationClick={onCitationClick}
          />
        ))}
      </Pressable>
      {showGapIndicator && <StreamingIndicator step="thinking" />}
      {/* Footer: copy button bottom-left, token ledger bottom-right
          ("+546/9,764sum" — this turn / running session total). */}
      <View style={s.assistantFooter}>
        {!isStreaming && <CopyButton onPress={copyText} colors={colors} />}
        {turnTokens > 0 && (
          <Text style={s.totalTokensText}>
            {formatTurnAndSessionTokens(turnTokens, sessionSum ?? turnTokens)}
          </Text>
        )}
      </View>
    </View>
  );
});

function CopyButton({ onPress, colors }: { onPress: () => void; colors: ThemeColors }) {
  const [copied, setCopied] = useState(false);
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={() => {
        onPress();
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        paddingHorizontal: 6,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: copied ? `${colors.primary}14` : "transparent",
      }}
    >
      {copied ? (
        <CheckIcon size={13} color={colors.primary} />
      ) : (
        <CopyIcon size={13} color={colors.mutedForeground} />
      )}
    </TouchableOpacity>
  );
}

function SelectableTextModal({
  text,
  colors,
  onClose,
}: {
  text: string | null;
  colors: ThemeColors;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const visible = text !== null;

  useEffect(() => {
    if (!visible) setCopied(false);
  }, [visible]);

  const handleCopyAll = useCallback(() => {
    if (!text) return;
    Clipboard.setStringAsync(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}
        onPress={onClose}
      >
        <Pressable
          style={{
            backgroundColor: colors.background,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 24,
            maxHeight: "75%",
          }}
          onPress={() => {}}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <Text style={{ color: colors.mutedForeground, fontSize: fs.xs }}>
              {t("chat.selectAndCopy", "长按选中文字复制")}
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TouchableOpacity
                onPress={handleCopyAll}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 6,
                  backgroundColor: copied ? `${colors.primary}14` : colors.muted,
                }}
              >
                {copied ? (
                  <CheckIcon size={13} color={colors.primary} />
                ) : (
                  <CopyIcon size={13} color={colors.foreground} />
                )}
                <Text style={{ color: colors.foreground, fontSize: fs.xs }}>
                  {t("common.copyAll", "全部复制")}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onClose}
                style={{ paddingHorizontal: 8, paddingVertical: 4 }}
              >
                <Text style={{ color: colors.mutedForeground, fontSize: fs.sm }}>
                  {t("common.close", "关闭")}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
          <TextInput
            value={text ?? ""}
            editable={false}
            multiline
            scrollEnabled
            textAlignVertical="top"
            selectionColor={colors.primary}
            style={{
              color: colors.foreground,
              fontSize: fs.sm,
              lineHeight: 22,
              padding: 12,
              backgroundColor: colors.muted,
              borderRadius: 8,
              minHeight: 200,
              maxHeight: 480,
            }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1 },
    listContent: { paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
    systemRow: {
      marginTop: 16,
    },
    systemCard: {
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: radius.md,
      borderLeftWidth: 3,
      borderLeftColor: colors.primary,
      backgroundColor: withOpacity(colors.muted, 0.72),
    },
    systemCardLabel: {
      fontSize: fs.xs,
      fontWeight: "600",
      color: colors.primary,
      marginBottom: 3,
    },
    systemCardText: {
      fontSize: fs.sm,
      lineHeight: 19,
      color: colors.foreground,
    },
    userRow: {
      flexDirection: "row",
      justifyContent: "flex-end",
      marginTop: 16,
    },
    userBubble: {
      maxWidth: "85%",
      backgroundColor: colors.muted,
      borderRadius: radius.xl + 4,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    userText: {
      fontSize: fs.sm,
      lineHeight: 20,
      color: colors.foreground,
    },
    assistantRow: {
      gap: 4,
    },
    assistantFooter: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 2,
    },
    totalTokensText: {
      fontSize: fs.xs,
      color: colors.mutedForeground,
      fontVariant: ["tabular-nums"],
    },
    scrollDownWrap: {
      position: "absolute",
      bottom: 8,
      left: 0,
      right: 0,
      alignItems: "center",
    },
    scrollDownBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 4,
    },
    scrollDownText: {
      fontSize: fs.xs,
      color: colors.mutedForeground,
    },
  });
