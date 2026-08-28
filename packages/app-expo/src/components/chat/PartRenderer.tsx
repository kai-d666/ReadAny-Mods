import { MermaidView } from "@/components/common/MermaidView";
import { MindmapView } from "@/components/common/MindmapView";
import { BrainIcon, CheckIcon, ChevronDownIcon, OctagonXIcon, XIcon } from "@/components/ui/Icon";
import { useThrottledValue } from "@/hooks";
import { fontSize as fs, fontWeight as fw, radius, useColors, withOpacity } from "@/styles/theme";
import type { ThemeColors } from "@/styles/theme";
import type {
  AbortedPart,
  CitationPart,
  MermaidPart,
  MindmapPart,
  Part,
  ReasoningPart,
  TextPart,
  ToolCallPart,
} from "@readany/core/types/message";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface PartProps {
  part: Part;
  citations?: CitationPart[];
  onCitationClick?: (citation: CitationPart) => void;
  /** Sum of all LLM-call token counts in the whole assistant message. */
  totalTokens?: number;
  /** True only on the LAST part of the message that displays a token count —
   *  renders the total (1,123sum) to the left of its tk. */
  showTotalTokenUsage?: boolean;
}

function formatNumber(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 4,321,456tk — thousands separators + 'tk' suffix. */
function formatTokens(n: number): string {
  return `${formatNumber(n)}tk`;
}

/** 4,321,456sum — total across all LLM calls of one assistant message. */
export function formatTotalTokens(n: number): string {
  return `${formatNumber(n)}sum`;
}

export function PartRenderer({
  part,
  citations,
  onCitationClick,
  totalTokens,
  showTotalTokenUsage,
}: PartProps) {
  switch (part.type) {
    case "text":
      return <TextPartView part={part} citations={citations} onCitationClick={onCitationClick} />;
    case "reasoning":
      return (
        <ReasoningPartView
          part={part}
          totalTokens={totalTokens}
          showTotalTokenUsage={showTotalTokenUsage}
        />
      );
    case "tool_call":
      return (
        <ToolCallPartView
          part={part}
          totalTokens={totalTokens}
          showTotalTokenUsage={showTotalTokenUsage}
        />
      );
    case "citation":
      return null;
    case "mindmap":
      return <MindmapPartView part={part} />;
    case "mermaid":
      return <MermaidPartView part={part} />;
    case "aborted":
      return <AbortedPartView part={part} />;
    default:
      return null;
  }
}

function MindmapPartView({ part }: { part: MindmapPart }) {
  return <MindmapView markdown={part.markdown} title={part.title} />;
}

function MermaidPartView({ part }: { part: MermaidPart }) {
  return <MermaidView chart={part.chart} title={part.title} />;
}

function TextPartView({
  part,
  citations,
  onCitationClick,
}: {
  part: TextPart;
  citations?: CitationPart[];
  onCitationClick?: (citation: CitationPart) => void;
}) {
  const throttledText = useThrottledValue(part.text, 100);
  const isStreaming = part.status === "running";

  if (!throttledText.trim()) {
    return null;
  }

  return (
    <MarkdownRenderer
      content={throttledText}
      isStreaming={isStreaming}
      citations={citations}
      onCitationClick={onCitationClick}
    />
  );
}

function ReasoningPartView({
  part,
  totalTokens,
  showTotalTokenUsage,
}: {
  part: ReasoningPart;
  totalTokens?: number;
  showTotalTokenUsage?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(part.status === "running" || part.status === "completed");
  const throttledText = useThrottledValue(part.text, 100);
  const { t } = useTranslation();
  const colors = useColors();
  const s = makeReasoningStyles(colors);

  useEffect(() => {
    if (part.status === "running") setIsOpen(true);
  }, [part.status]);

  if (!part.text?.trim()) return null;

  return (
    <View style={s.container}>
      <TouchableOpacity style={s.header} onPress={() => setIsOpen(!isOpen)} activeOpacity={0.7}>
        <View style={s.headerLeft}>
          {part.status === "running" ? (
            <View style={s.pulsingDot} />
          ) : (
            <BrainIcon size={14} color={colors.mutedForeground} />
          )}
          <Text style={s.headerText}>
            {part.status === "running"
              ? t("streaming.reasoningRunning", "思考中...")
              : t("streaming.reasoningDone", "思考完成")}
          </Text>
        </View>
        {renderTokenBadge(part.tokens, totalTokens, showTotalTokenUsage, s.tokenText)}
        <View style={[s.chevron, isOpen && s.chevronOpen]}>
          <ChevronDownIcon size={14} color={colors.mutedForeground} />
        </View>
      </TouchableOpacity>
      {isOpen && (
        <View style={s.body}>
          <ScrollView
            style={s.bodyScroll}
            nestedScrollEnabled
            showsVerticalScrollIndicator={true}
            scrollEventThrottle={16}
          >
            <Text style={s.bodyText}>{throttledText}</Text>
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const TOOL_LABEL_KEYS: Record<string, string> = {
  ragSearch: "toolLabels.ragSearch",
  ragToc: "toolLabels.ragToc",
  ragContext: "toolLabels.ragContext",
  summarize: "toolLabels.summarize",
  extractEntities: "toolLabels.extractEntities",
  analyzeArguments: "toolLabels.analyzeArguments",
  findQuotes: "toolLabels.findQuotes",
  getAnnotations: "toolLabels.getAnnotations",
  addCitation: "toolLabels.addCitation",
  compareSections: "toolLabels.compareSections",
  getSelection: "toolLabels.getSelection",
  getReadingProgress: "toolLabels.getReadingProgress",
  getRecentHighlights: "toolLabels.getRecentHighlights",
  getSurroundingContext: "toolLabels.getSurroundingContext",
  listBooks: "toolLabels.listBooks",
  searchAllHighlights: "toolLabels.searchAllHighlights",
  searchAllNotes: "toolLabels.searchAllNotes",
  getReadingStats: "toolLabels.getReadingStats",
  getSkills: "toolLabels.getSkills",
  mindmap: "toolLabels.mindmap",
  fallbackToc: "toolLabels.fallbackToc",
  fallbackSearch: "toolLabels.fallbackSearch",
  fallbackChapterContext: "toolLabels.fallbackChapterContext",
};

/** Header right-side token info: [1,123sum  2,411tk] — the sum (total of all
 *  LLM calls in this message) only on the last token-bearing part. */
function renderTokenBadge(
  partTokens: number | undefined,
  totalTokens: number | undefined,
  showTotalTokenUsage: boolean | undefined,
  tokenStyle: { fontSize: number; color: string; fontVariant: ("tabular-nums")[] },
) {
  if (partTokens == null) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {showTotalTokenUsage && totalTokens != null ? (
        <Text style={{ ...tokenStyle, fontWeight: "600" }}>{formatTotalTokens(totalTokens)}</Text>
      ) : null}
      <Text style={tokenStyle}>{formatTokens(partTokens)}</Text>
    </View>
  );
}

function ToolCallPartView({
  part,
  totalTokens,
  showTotalTokenUsage,
}: {
  part: ToolCallPart;
  totalTokens?: number;
  showTotalTokenUsage?: boolean;
}) {
  const hasError = part.status === "error" || Boolean(part.error);

  const [isOpen, setIsOpen] = useState(hasError);
  const { t } = useTranslation();
  const colors = useColors();
  const s = makeToolStyles(colors);

  useEffect(() => {
    if (hasError) setIsOpen(true);
  }, [hasError]);

  const getStatusIcon = () => {
    switch (part.status) {
      case "pending":
        return <View style={[s.dot, { backgroundColor: colors.mutedForeground }]} />;
      case "running":
        return <ActivityIndicator size="small" color={colors.blue} />;
      case "completed":
        return <CheckIcon size={14} color={colors.emerald} />;
      case "error":
        return <XIcon size={14} color={colors.destructive} />;
      default:
        return <View style={[s.dot, { backgroundColor: colors.mutedForeground }]} />;
    }
  };

  const label = TOOL_LABEL_KEYS[part.name] ? t(TOOL_LABEL_KEYS[part.name]) : part.name;
  const queryText = part.args.query ? String(part.args.query) : "";
  const errorMessage =
    part.error ||
    (part.result && typeof part.result === "object"
      ? String((part.result as Record<string, unknown>).error || "")
      : "");

  return (
    <View style={[s.container, hasError && s.errorContainer]}>
      <TouchableOpacity style={s.header} onPress={() => setIsOpen(!isOpen)} activeOpacity={0.7}>
        <View style={s.headerLeft}>
          {getStatusIcon()}
          <Text style={s.headerText} numberOfLines={1}>
            {label}
          </Text>
          {hasError ? (
            <View style={s.errorBadge}>
              <Text style={s.errorBadgeText}>{t("streaming.toolFailed", "调用失败")}</Text>
            </View>
          ) : null}
          {queryText ? (
            <Text style={s.queryText} numberOfLines={1}>
              {queryText.slice(0, 30)}
            </Text>
          ) : null}
        </View>
        {renderTokenBadge(part.tokens, totalTokens, showTotalTokenUsage, s.tokenText)}
        <View style={[s.chevron, isOpen && s.chevronOpen]}>
          <ChevronDownIcon size={14} color={colors.mutedForeground} />
        </View>
      </TouchableOpacity>
      {isOpen && (
        <View style={s.body}>
          {Object.keys(part.args).length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionTitle}>{t("common.params", "参数")}</Text>
              <View style={s.codeBlock}>
                {Object.entries(part.args).map(([key, value]) => (
                  <Text key={key} style={s.codeText}>
                    <Text style={s.codeKey}>{key}: </Text>
                    {typeof value === "string" && value.length > 80
                      ? `${value.slice(0, 80)}...`
                      : String(value)}
                  </Text>
                ))}
              </View>
            </View>
          )}
          {part.result !== undefined && (
            <View style={s.section}>
              <Text style={s.sectionTitle}>{t("common.result", "结果")}</Text>
              <View style={s.codeBlockScroll}>
                <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled>
                  <Text style={s.codeText}>
                    {typeof part.result === "string" && part.result.length > 500
                      ? `${part.result.slice(0, 500)}...`
                      : JSON.stringify(part.result, null, 2)}
                  </Text>
                </ScrollView>
              </View>
            </View>
          )}
          {hasError && (
            <View style={s.errorBlock}>
              <Text style={s.errorTitle}>{t("streaming.toolFailedDetail", "工具调用失败")}</Text>
              <Text style={s.errorText}>{errorMessage || t("streaming.toolFailed", "调用失败")}</Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function AbortedPartView({ part }: { part: AbortedPart }) {
  const colors = useColors();
  return (
    <View
      style={{
        marginVertical: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: withOpacity(colors.amber, 0.3),
        backgroundColor: withOpacity(colors.amber, 0.1),
      }}
    >
      <OctagonXIcon size={16} color={colors.amber} />
      <Text style={{ fontSize: fs.sm, color: colors.amber }}>{part.reason}</Text>
    </View>
  );
}

const makeReasoningStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      marginVertical: 4,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: withOpacity(colors.muted, 0.5),
      overflow: "hidden",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    headerLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      flex: 1,
    },
    pulsingDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: colors.primary,
      opacity: 0.6,
    },
    headerText: {
      fontSize: fs.sm,
      fontWeight: fw.medium,
      color: colors.foreground,
    },
    tokenText: {
      fontSize: fs.xs,
      color: colors.mutedForeground,
      marginRight: 6,
      fontVariant: ["tabular-nums"],
    },
    chevron: {},
    chevronOpen: { transform: [{ rotate: "180deg" }] },
    body: {
      borderTopWidth: 0.5,
      borderTopColor: colors.border,
      backgroundColor: withOpacity(colors.card, 0.5),
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    bodyScroll: {
      maxHeight: 300,
    },
    bodyText: {
      fontSize: fs.sm,
      lineHeight: 18,
      color: colors.foreground,
      opacity: 0.85,
    },
  });

const makeToolStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      marginVertical: 4,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: "hidden",
    },
    errorContainer: {
      borderColor: withOpacity(colors.destructive, 0.35),
      backgroundColor: withOpacity(colors.destructive, 0.04),
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    headerLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      flex: 1,
    },
    dot: { width: 8, height: 8, borderRadius: 4 },
    headerText: {
      fontSize: fs.sm,
      fontWeight: fw.medium,
      color: colors.foreground,
    },
    queryText: {
      flex: 1,
      fontSize: fs.xs,
      fontFamily: "Menlo",
      color: colors.mutedForeground,
    },
    tokenText: {
      fontSize: fs.xs,
      color: colors.mutedForeground,
      marginRight: 6,
      fontVariant: ["tabular-nums"],
    },
    errorBadge: {
      borderRadius: radius.sm,
      backgroundColor: withOpacity(colors.destructive, 0.1),
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    errorBadgeText: {
      fontSize: fs.xs,
      color: colors.destructive,
      fontWeight: fw.medium,
    },
    chevron: {},
    chevronOpen: { transform: [{ rotate: "180deg" }] },
    body: {
      borderTopWidth: 0.5,
      borderTopColor: colors.border,
      backgroundColor: colors.muted,
      padding: 10,
      gap: 8,
    },
    section: { gap: 4 },
    sectionTitle: {
      fontSize: fs.xs,
      fontWeight: fw.medium,
      color: colors.mutedForeground,
    },
    codeBlock: {
      borderWidth: 0.5,
      borderColor: colors.border,
      backgroundColor: colors.card,
      borderRadius: radius.sm,
      padding: 8,
    },
    codeBlockScroll: {
      borderWidth: 0.5,
      borderColor: colors.border,
      backgroundColor: colors.card,
      borderRadius: radius.sm,
      padding: 8,
      maxHeight: 200,
    },
    codeText: {
      fontSize: fs.xs,
      fontFamily: "Menlo",
      color: colors.foreground,
      lineHeight: 16,
    },
    codeKey: { color: colors.mutedForeground },
    errorBlock: {
      borderWidth: 0.5,
      borderColor: colors.destructive,
      backgroundColor: withOpacity(colors.destructive, 0.05),
      borderRadius: radius.sm,
      padding: 8,
    },
    errorText: {
      fontSize: fs.xs,
      color: colors.destructive,
      lineHeight: 16,
    },
    errorTitle: {
      marginBottom: 4,
      fontSize: fs.xs,
      fontWeight: fw.medium,
      color: colors.destructive,
    },
  });
