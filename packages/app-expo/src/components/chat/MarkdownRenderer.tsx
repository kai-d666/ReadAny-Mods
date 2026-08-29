// MarkdownRenderer — 原生 markdown 渲染(react-native-enriched-markdown 0.4.0)。
// 与旧的 react-native-markdown-display 同接口(组件 props 不变,调用点零改动),
// 但渲染管线换成 md4c 原生解析 + Fabric 原生文本渲染:
// - JS 线程零解析/零组件树(消除长回复流式/切换会话的 JS 阻塞帧)
// - 支持 GFM(表格/任务列表)、markdownStyle 全元素样式定制
// 包装层补两件事(md4c 渲染器不支持嵌入自定义组件):
// 1. ```mermaid 块剥离出来按原位置插入 MermaidView(段交替渲染)
// 2. citations 的 [N] 标记转成 readany-cite://N 链接,onLinkPress 转发跳转
import { MermaidView } from "@/components/common/MermaidView";
import { fontSize as fs, radius, useColors } from "@/styles/theme";
import type { ThemeColors } from "@/styles/theme";
import type { CitationPart } from "@readany/core/types/message";
import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { EnrichedMarkdownText, type MarkdownStyle } from "react-native-enriched-markdown";

interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
  styleOverrides?: Record<string, any>;
  citations?: CitationPart[];
  onCitationClick?: (citation: CitationPart) => void;
}

const CITE_PROTOCOL = "readany-cite://";

interface RenderSegment {
  /** 该段渲染的 markdown 文本 */
  text: string;
  /** mermaid 块的 markdown(有则该段是图表,不渲染文本) */
  mermaid?: string;
}

/** 按 ``` 围栏分割内容为 [文本段/代码段/mermaid 段] 交替序列:
 *  文本段由 md4c 原生渲染;mermaid 段剥离出来由 MermaidView 原位渲染;
 *  代码段原样保留在文本段内(代码块的样式/复制由原始处理保持)。 */
function splitSegments(content: string, citations?: CitationPart[]): RenderSegment[] {
  const segments: RenderSegment[] = [];
  let textBuf: string[] = [];
  let inFence = false;

  const flushText = () => {
    if (textBuf.length) {
      segments.push({ text: transformCitations(textBuf.join("```"), citations) });
      textBuf = [];
    }
  };

  for (const part of content.split("```")) {
    if (!inFence) {
      textBuf.push(part);
    } else {
      const firstLineEnd = part.indexOf("\n");
      const firstLine = (firstLineEnd === -1 ? part : part.slice(0, firstLineEnd)).trim();
      const body = firstLineEnd === -1 ? "" : part.slice(firstLineEnd + 1);
      if (firstLine.toLowerCase() === "mermaid") {
        flushText();
        segments.push({ text: "", mermaid: body.trim() });
      } else {
        // 代码块:复原 fenced 文本,交给 md4c 原生渲染
        textBuf.push("```" + part + "```");
      }
    }
    inFence = !inFence;
  }
  flushText();
  return segments;
}

/** citations 存在时,文本里的 [N] 转成 markdown 链接(点击转发给 onCitationClick)。 */
function transformCitations(text: string, citations?: CitationPart[]): string {
  if (!citations || citations.length === 0 || !/\[\d+\]/.test(text)) return text;
  // 与旧实现(renderTextWithCitations)行为一致:全文本替换,代码块内的 [N]
  // 不受影响(splitSegments 的文本段已排除 fence 代码块)。
  return text.replace(/\[(\d+)\]/g, (match, num: string) => {
    const n = Number.parseInt(num, 10);
    const hit = citations.find((c) => c.citationIndex === n) ?? citations[n - 1];
    return hit ? `[${num}](${CITE_PROTOCOL}${num})` : match;
  });
}

export function MarkdownRenderer({
  content,
  citations,
  onCitationClick,
}: MarkdownRendererProps) {
  const colors = useColors();
  const segments = useMemo(() => splitSegments(content, citations), [content, citations]);
  const markdownStyle = useMemo(() => buildMarkdownStyle(colors), [colors]);

  const handleLinkPress = useCallback(
    ({ url }: { url: string }) => {
      const match = url?.match(new RegExp(`^${CITE_PROTOCOL.replace(/[/:$]/g, "\\$&")}(\\d+)`));
      if (match && citations) {
        const num = Number.parseInt(match[1], 10);
        const citation = citations.find((c) => c.citationIndex === num) ?? citations[num - 1];
        if (citation) onCitationClick?.(citation);
        return;
      }
      // 其余链接:与旧实现一致,仅展示不打开
    },
    [citations, onCitationClick],
  );

  return (
    <View>
      {segments.map((seg, i) =>
        seg.mermaid !== undefined ? (
          <MermaidView key={`md-${i}`} chart={seg.mermaid} title="" />
        ) : (
          <EnrichedMarkdownText
            key={`md-${i}`}
            flavor="github"
            markdown={seg.text}
            markdownStyle={markdownStyle}
            onLinkPress={handleLinkPress}
          />
        ),
      )}
    </View>
  );
}

/** 主题 → md4c markdownStyle 映射(键名与 0.4.0 类型一致,沿用旧视觉参数)。 */
const buildMarkdownStyle = (colors: ThemeColors): MarkdownStyle => ({
  paragraph: {
    fontSize: fs.sm,
    lineHeight: 20,
    color: colors.foreground,
    marginTop: 0,
    marginBottom: 8,
  },
  h1: {
    color: colors.foreground,
    fontSize: fs.lg,
    fontWeight: "700",
    marginTop: 12,
    marginBottom: 8,
  },
  h2: {
    color: colors.foreground,
    fontSize: fs.md,
    fontWeight: "700",
    marginTop: 10,
    marginBottom: 6,
  },
  h3: {
    color: colors.foreground,
    fontSize: fs.base,
    fontWeight: "700",
    marginTop: 8,
    marginBottom: 4,
  },
  h4: {
    color: colors.foreground,
    fontSize: fs.base,
    fontWeight: "700",
    marginTop: 8,
    marginBottom: 4,
  },
  h5: {
    color: colors.foreground,
    fontSize: fs.base,
    fontWeight: "700",
    marginTop: 8,
    marginBottom: 4,
  },
  h6: {
    color: colors.foreground,
    fontSize: fs.base,
    fontWeight: "700",
    marginTop: 8,
    marginBottom: 4,
  },
  blockquote: {
    color: colors.mutedForeground,
    borderColor: colors.border,
    borderWidth: 3,
    gapWidth: 12,
    backgroundColor: "transparent",
    marginTop: 6,
    marginBottom: 6,
  },
  list: {
    color: colors.foreground,
    bulletColor: colors.mutedForeground,
    marginTop: 4,
    marginBottom: 4,
  },
  codeBlock: {
    backgroundColor: colors.muted,
    color: colors.foreground,
    padding: 12,
    borderRadius: radius.md,
    marginTop: 6,
    marginBottom: 6,
  },
  code: {
    backgroundColor: colors.muted,
    color: colors.foreground,
    fontSize: fs.xs + 1,
  },
  link: { color: colors.blue, underline: false },
  strong: { fontWeight: "bold" },
  em: { fontStyle: "italic" },
  strikethrough: { color: colors.foreground },
  underline: { color: colors.foreground },
  thematicBreak: { color: colors.border, height: 1, marginTop: 12, marginBottom: 12 },
  image: { borderRadius: radius.md },
});
