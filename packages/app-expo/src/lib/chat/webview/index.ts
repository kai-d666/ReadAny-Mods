/**
 * ReadAny Chat WebView Runtime — esbuild entry。
 * 由 scripts/build-chat.js 打进 template.html,经窗口注入 chatHtml.generated.ts。
 * 职责:消息列表 DOM 渲染(1:1 复刻 RN MessageList/PartRenderer 视觉与交互)、
 * 流式文本尾部追加、marked 完成态排版、引用 [N] 后处理、图表 CDN 惰性渲染、
 * 自动滚动。桥:webview→RN postToRN;RN→webview __chat.dispatch。
 */
import { marked } from "marked";

declare const __CHAT_BUILD_ID__: string | undefined;

// ────────────────────────── 类型(与 RN 侧 SerializableMessage 对齐)──────────────────────────

interface SerializablePart {
  id: string;
  type: string;
  status: string;
  createdAt?: number;
  text?: string;
  tokens?: number | null;
  thinkingType?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  reasoning?: string;
  notice?: string;
  bookId?: string;
  chapterTitle?: string;
  chapterIndex?: number;
  cfi?: string;
  citationIndex?: number;
  source?: string;
  title?: string;
  markdown?: string;
  chart?: string;
  reason?: string;
}

interface SerializableMessage {
  id: string;
  threadId: string;
  role: string;
  createdAt: number;
  parts: SerializablePart[];
}

interface ChatCommand {
  type: string;
  [key: string]: unknown;
}

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (s: string) => void };
    __postToRN?: (type: string, data: Record<string, unknown>) => void;
    __chat: { dispatch: ((cmd: ChatCommand) => void) | null; flushQueue?: () => void };
    marked?: unknown;
    mermaid?: any;
    d3?: any;
    markmap?: any;
  }
}

// ────────────────────────── 全局状态 ──────────────────────────

const rt = {
  isStreaming: false,
  step: "idle" as string,
  vars: {} as Record<string, string>,
  strings: {} as Record<string, string>,
  toolLabels: {} as Record<string, string>,
  atBottom: true,
  chartLibs: { mermaid: false, markmap: false, chartAttempted: false } as {
    mermaid: boolean;
    markmap: boolean;
    chartAttempted: boolean;
  },
};

const messagesEl = new Map<string, HTMLElement>(); // messageId -> .msg
const partsByMsg = new Map<string, Map<string, PartEntry>>(); // messageId -> partId -> entry
const citationsByMsg = new Map<string, SerializablePart[]>(); // messageId -> sorted citations
const order: HTMLElement[] = []; // DOM 顺序(插入顺序维护)

interface PartEntry {
  el: HTMLElement;
  type: string;
  len: number; // text/reasoning 已渲染字符数
}

let listEl: HTMLDivElement;
let footerIndicatorEl: HTMLDivElement;
let scrollPillEl: HTMLDivElement;
let booted = false;

// ────────────────────────── 工具 ──────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtNumber(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function varVal(name: string, fallback: string): string {
  return rt.vars[name] || fallback;
}

function s(label: string, fb: string): string {
  return rt.strings[label] || fb;
}

function partTokens(p: SerializablePart): number | undefined {
  return typeof p.tokens === "number" ? p.tokens : undefined;
}

function toolLabel(name: string): string {
  return rt.toolLabels[name] || name;
}

function sortCitationsByIndex(citations: SerializablePart[]): SerializablePart[] {
  return citations.slice().sort((a, b) => {
    const ia = a.citationIndex;
    const ib = b.citationIndex;
    if (ia == null || ib == null) return 0;
    return ia - ib;
  });
}

function msgTotalTokens(msg: SerializableMessage): number {
  return msg.parts.reduce((sum, p) => sum + (partTokens(p) ?? 0), 0);
}

function msgCopyText(msg: SerializableMessage): string {
  return msg.parts
    .filter((p) => p.type === "text" && p.text && p.text.trim())
    .map((p) => p.text)
    .join("\n\n");
}

function showGapIndicator(msg: SerializableMessage): boolean {
  const lastPart = msg.parts[msg.parts.length - 1];
  if (!lastPart) return false;
  const lastRunningText = lastPart.type === "text" && lastPart.status === "running";
  const lastActiveTool = lastPart.type === "tool_call" && (lastPart.status === "pending" || lastPart.status === "running");
  const lastRunningReasoning = lastPart.type === "reasoning" && lastPart.status === "running";
  return (
    rt.isStreaming &&
    rt.step !== "idle" &&
    Boolean(lastPart) &&
    !lastRunningText &&
    !lastActiveTool &&
    !lastRunningReasoning
  );
}

// ────────────────────────── Markdown + 引用后处理 ──────────────────────────

function citationsOf(msgId: string): SerializablePart[] {
  return citationsByMsg.get(msgId) ?? [];
}

function renderMarkdown(text: string, msgId: string): HTMLDivElement {
  const root = el("div", "markdown");
  const tokens = marked.parse(text, { gfm: true, breaks: false, async: false }) as string;
  root.innerHTML = tokens;
  postprocessImages(root);
  postprocessCitations(root, citationsOf(msgId));
  return root;
}

function postprocessImages(root: HTMLElement) {
  // 模型输出图片:仅允许 http(s) src,其余移除(防注入/防私有协议)
  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (!/^https?:\/\//i.test(src)) img.remove();
  });
}

/** [N] → cite-link(跳过 pre/code 子树;与 RN transformCitations 行为一致) */
function postprocessCitations(root: HTMLElement, citations: SerializablePart[]) {
  if (!citations.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    const parent = n.parentElement;
    if (parent && parent.closest("pre, code, a")) continue;
    if (!/\[\d+\]/.test(n.data)) continue;
    nodes.push(n);
  }
  for (const node of nodes) {
    const text = node.data;
    node.data = "";
    const frag = document.createDocumentFragment();
    let last = 0;
    const re = /\[(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const num = m[1];
      const hit = citations.find((c) => c.citationIndex === Number(num)) ?? citations[Number(num) - 1];
      if (hit) {
        const a = document.createElement("a");
        a.className = "cite-link";
        a.textContent = m[0];
        a.setAttribute("data-cite-idx", num);
        frag.appendChild(a);
      } else {
        frag.appendChild(document.createTextNode(m[0]));
      }
      last = m.index + m[0].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }
}

// ────────────────────────── 可折叠卡 ──────────────────────────

function buildReasoningPartEl(part: SerializablePart): HTMLElement {
  const card = el("div", "collapsible part-reasoning");
  // RN 初始展开 = running | completed
  const open = part.status === "running" || part.status === "completed";
  if (open) card.classList.add("open");

  const header = el("div", "collapsible-header");
  if (part.status === "running") {
    header.appendChild(el("span", "pulsing-dot"));
  } else {
    const brain = el("span", "status-brain", "🧠");
    header.appendChild(brain);
  }
  header.appendChild(
    el(
      "span",
      "header-text",
      part.status === "running" ? s("streaming.reasoningRunning", "思考中...") : s("streaming.reasoningDone", "思考完成"),
    ),
  );
  const badges = buildTokenBadges(part);
  if (badges) header.appendChild(badges);
  const chev = el("span", "chevron", "▾");
  header.appendChild(chev);

  const body = el("div", "collapsible-body");
  const bodyText = el("div", "reasoning-body-text", part.text || "");
  body.appendChild(bodyText);

  header.addEventListener("click", () => card.classList.toggle("open"));
  card.appendChild(header);
  card.appendChild(body);
  return card;
}

function buildTokenBadges(part: SerializablePart): HTMLElement | null {
  const tokens = partTokens(part);
  if (tokens == null) return null;
  const wrap = el("span", "token-badges");
  // note: totalTokens sum 在 footer;part 级只显示本 part tk
  const t = el("span", "tk", `${fmtNumber(tokens)}tk`);
  wrap.appendChild(t);
  return wrap;
}

const TOOL_DEFAULT_LABEL = "工具";

function buildToolPartEl(part: SerializablePart): HTMLElement {
  const hasError = part.status === "error" || Boolean(part.error);
  const card = el("div", "collapsible part-tool" + (hasError ? " tool-error" : ""));
  if (hasError) card.classList.add("open"); // RN: 初始 open = hasError

  const header = el("div", "collapsible-header");
  header.appendChild(el("span", "status-" + statusClass(part.status)));

  header.appendChild(el("span", "header-text", toolLabel(part.name || TOOL_DEFAULT_LABEL)));
  if (hasError) {
    const badge = el("span", "error-badge", s("streaming.toolFailed", "调用失败"));
    header.appendChild(badge);
  }
  const query = part.args && typeof part.args.query === "string" ? String(part.args.query) : "";
  if (query) {
    header.appendChild(el("span", "header-sub", query.slice(0, 30)));
  }
  const badges = buildTokenBadges(part);
  if (badges) header.appendChild(badges);
  header.appendChild(el("span", "chevron", "▾"));

  const body = el("div", "collapsible-body");
  const args = part.args ?? {};
  if (Object.keys(args).length > 0) {
    const section = el("div", "body-section");
    section.appendChild(el("div", "section-title", s("common.params", "参数")));
    const code = el("div", "code-block");
    for (const key of Object.keys(args)) {
      const line = el("div");
      const k = el("span", "k", `${key}: `);
      const raw = args[key];
      let val = typeof raw === "string" ? raw : JSON.stringify(raw);
      if (typeof raw === "string" && raw.length > 80) val = `${raw.slice(0, 80)}...`;
      line.appendChild(k);
      line.appendChild(document.createTextNode(val ?? ""));
      code.appendChild(line);
    }
    section.appendChild(code);
    body.appendChild(section);
  }
  if (part.result !== undefined) {
    const section = el("div", "body-section");
    section.appendChild(el("div", "section-title", s("common.result", "结果")));
    const code = el("div", "code-block tool-result");
    let out: string;
    let isTruncated = false;
    if (typeof part.result === "string" && part.result.length > 500) {
      out = part.result.slice(0, 500) + "...";
      isTruncated = true;
    } else {
      try {
        out = JSON.stringify(part.result, null, 2);
      } catch {
        out = String(part.result);
      }
      if (out.length > 500) {
        out = out.slice(0, 500) + "...";
      }
    }
    void isTruncated;
    code.textContent = out || "";
    section.appendChild(code);
    body.appendChild(section);
  }
  if (hasError) {
    const errBlock = el("div", "error-block");
    errBlock.appendChild(el("div", "error-title", s("streaming.toolFailedDetail", "工具调用失败")));
    const errMsg =
      part.error ||
      (part.result && typeof part.result === "object"
        ? String((part.result as Record<string, unknown>).error || "")
        : "");
    errBlock.appendChild(el("div", "error-text", errMsg || s("streaming.toolFailed", "调用失败")));
    body.appendChild(errBlock);
  }

  header.addEventListener("click", () => card.classList.toggle("open"));
  card.appendChild(header);
  card.appendChild(body);
  return card;
}

function statusClass(status: string): string {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "error":
      return "error";
    default:
      return "pending";
  }
}

function buildAbortedPartEl(part: SerializablePart): HTMLElement {
  const row = el("div", "aborted", part.reason || s("streaming.aborted", "已停止生成"));
  return row;
}

// ────────────────────────── 消息构建 ──────────────────────────

function buildMessageEl(msg: SerializableMessage): HTMLElement {
  // citation 必须先进注册表:renderMarkdown 的 [N] 后处理在构建 part 时执行
  citationsByMsg.set(msg.id, sortCitationsByIndex(msg.parts.filter((p) => p.type === "citation")));
  if (msg.role === "system") {
    const row = el("div", "msg msg-system");
    const card = el("div", "system-card");
    const textPart = msg.parts.find((p) => p.type === "text");
    card.appendChild(el("div", "system-label", s("chatThreadContext", "会话上下文")));
    card.appendChild(el("div", "system-text", (textPart && textPart.text) || ""));
    row.appendChild(card);
    return row;
  }

  if (msg.role === "user") {
    const row = el("div", "msg msg-user");
    const bubble = el("div", "user-bubble");
    const quoteParts = msg.parts.filter((p) => p.type === "quote");
    const textParts = msg.parts.filter((p) => p.type === "text");
    quoteParts.forEach((q) => bubble.appendChild(buildQuoteBlockEl(q, msg.id)));
    for (const part of textParts) {
      bubble.appendChild(el("div", "user-text", part.text || ""));
    }
    row.appendChild(bubble);
    return row;
  }

  // assistant
  const hasContent = msg.parts.some(
    (p) => (p.type === "text" && p.text && p.text.trim()) || p.type !== "text",
  );
  if (!hasContent) {
    const empty = el("div", "msg msg-assistant");
    empty.style.display = "none";
    return empty;
  }

  const row = el("div", "msg msg-assistant");
  const body = el("div", "assistant-body");

  for (const part of msg.parts) {
    const partEl = buildPartEl(part, msg.id);
    if (partEl) {
      partEl.setAttribute("data-pid", part.id);
      body.appendChild(partEl);
    }
  }

  // gap indicator 占位(流式等待态/工具卡加载时显示;状态变化局部更新显隐)
  const gap = el("span", "step-pill gap-anchor");
  gap.style.display = showGapIndicator(msg) ? "inline-flex" : "none";
  gap.textContent = s("streaming.thinking", "正在思考...");
  body.appendChild(gap);

  // footer:copy + sum
  const footer = el("div", "assistant-footer");
  if (!rt.isStreaming) {
    const copyBtn = el("button", "copy-btn");
    copyBtn.appendChild(el("span", "ic-copy"));
    copyBtn.appendChild(el("span", "copy-label", s("common.copy", "复制")));
    const text = msgCopyText(msg);
    copyBtn.addEventListener("click", () => {
      if (!text) return;
      postToRN("copy", { messageId: msg.id, text });
      copyBtn.classList.add("copied");
      copyBtn.querySelector(".copy-label")!.textContent = s("common.copied", "已复制");
      setTimeout(() => {
        copyBtn.classList.remove("copied");
        copyBtn.querySelector(".copy-label")!.textContent = s("common.copy", "复制");
      }, 2000);
    });
    footer.appendChild(copyBtn);
  }
  const totalTokens = msgTotalTokens(msg);
  if (totalTokens > 0) {
    footer.appendChild(el("span", "token-sum", `${fmtNumber(totalTokens)}sum`));
  }
  if (footer.childElementCount > 0) body.appendChild(footer);

  row.appendChild(body);
  return row;
}

function buildQuoteBlockEl(part: SerializablePart, messageId: string): HTMLElement {
  const block = el("div", "quote-block");
  const wrap = el("div", "quote-text-wrap");
  wrap.appendChild(el("div", "quote-text", part.text || ""));
  if (part.source) wrap.appendChild(el("div", "quote-source", `— ${part.source}`));
  block.appendChild(wrap);
  if (part.cfi) {
    const jump = el("span", "quote-jump", "↗");
    block.classList.add("clickable");
    block.addEventListener("click", () =>
      postToRN("quoteClick", { messageId, partId: part.id, text: part.text || "", cfi: part.cfi }),
    );
    block.appendChild(jump);
  }
  return block;
}

function buildPartEl(part: SerializablePart, messageId: string): HTMLElement | null {
  switch (part.type) {
    case "text": {
      const wrap = el("div", "part part-text");
      if (part.status === "running") {
        const span = el("span", "part-text-plain stream-cursor", part.text || "");
        wrap.appendChild(span);
      } else {
        // 冷态:先纯文本零解析挂载(长会话首帧不被 marked 阻塞),
        // 随后由 scheduleRich 从底部开始分批富化(可见区 0.3s 内富化)
        const plain = el("div", "markdown plain-pending", part.text || "");
        wrap.appendChild(plain);
        queueRich(messageId, part.id, part.text || "");
      }
      return wrap;
    }
    case "reasoning":
      if (!part.text || !part.text.trim()) return null;
      return buildReasoningPartEl(part);
    case "tool_call":
      return buildToolPartEl(part);
    case "aborted":
      return buildAbortedPartEl(part);
    case "mermaid":
      return buildMermaidPartEl(part);
    case "mindmap":
      return buildMindmapPartEl(part);
    case "citation":
    case "quote":
      return null; // citation 是数据提供者;quote 在用户气泡内渲染
    default:
      return null;
  }
}

// ────────────────────────── 图表(CDN 惰性,逻辑照搬 MermaidView/MindmapView)──────────────────────────

const MERMAID_SRC = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
const D3_SRC = "https://cdn.jsdelivr.net/npm/d3@7";
const MARKMAP_SRC = "https://cdn.jsdelivr.net/npm/markmap-autoloader@0.18.12/dist/index.js";

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const sc = document.createElement("script");
    sc.src = src;
    sc.onload = () => resolve();
    sc.onerror = () => reject(new Error("CDN load failed: " + src));
    document.head.appendChild(sc);
  });
}

function waitFor(cond: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(t);
        resolve(false);
      }
    }, intervalMs);
  });
}

function buildMermaidPartEl(part: SerializablePart): HTMLElement {
  const card = el("div", "chart-card part-mermaid");
  const header = el("div", "collapsible-header");
  header.appendChild(
    el("span", "header-text", part.title || s("mindmap.mermaidChart", "Mermaid 图表")),
  );
  card.appendChild(header);
  const box = el("div", "chart-box");
  box.style.height = "280px";
  box.style.position = "relative";
  box.style.display = "flex";
  box.style.alignItems = "center";
  box.style.justifyContent = "center";
  box.style.background = "transparent";
  box.style.userSelect = "none";
  box.style.webkitUserSelect = "none";
  card.appendChild(box);
  const hint = el("div", "chart-hint", s("mindmap.zoomHint", "双击放大 · 双指缩放 · 拖动移动"));
  card.appendChild(hint);
  void part;
  renderMermaidInto(box, part.chart || "", part.title || "");
  return card;
}

function renderMermaidInto(box: HTMLElement, chart: string, title: string) {
  void title;
  const showError = (msg: string) => {
    box.innerHTML = "";
    const errEl = el("div", "chart-error", msg);
    const retry = el("button", "chart-retry", s("common.retry", "重试"));
    retry.addEventListener("click", () => {
      rt.chartLibs.mermaid = false;
      renderMermaidInto(box, chart, title);
    });
    errEl.appendChild(retry);
    box.appendChild(errEl);
  };

  injectScript(MERMAID_SRC)
    .then(() => injectScript(D3_SRC))
    .then(() => waitFor(() => Boolean(window.mermaid && window.d3), 15000))
    .then((ok) => {
      if (!ok) {
        showError(s("mindmap.chartLoadFailed", "图表加载失败(网络?)"));
        return;
      }
      const vars = rt.vars;
      window.mermaid.initialize({
        startOnLoad: false,
        theme: "base",
        themeVariables: {
          primaryColor: vars["--card"],
          primaryTextColor: vars["--fg"],
          primaryBorderColor: vars["--border"],
          lineColor: vars["--fg"],
          secondaryColor: vars["--muted"],
          tertiaryColor: vars["--bg"],
          fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        },
        flowchart: { useMaxWidth: false, htmlLabels: true, curve: "basis" },
        sequence: { useMaxWidth: false },
        gantt: { useMaxWidth: false },
      });
      window.mermaid
        .render("mermaid-svg-" + Date.now(), chart)
        .then((result: { svg: string }) => {
          box.innerHTML = result.svg;
          const svg = box.querySelector("svg");
          if (!svg) return;
          const viewBox = svg.getAttribute("viewBox");
          const width = svg.getAttribute("width");
          const height = svg.getAttribute("height");
          svg.style.width = "100%";
          svg.style.height = "100%";
          svg.style.cursor = "grab";
          svg.style.touchAction = "none";
          svg.removeAttribute("width");
          svg.removeAttribute("height");
          if (!viewBox && width && height) {
            svg.setAttribute("viewBox", "0 0 " + width + " " + height);
          }
          let contentG = svg.querySelector(".mermaid-content") as SVGGElement | null;
          if (!contentG) {
            contentG = document.createElementNS("http://www.w3.org/2000/svg", "g");
            contentG.setAttribute("class", "mermaid-content");
            const g = contentG;
            const children = Array.from(svg.childNodes);
            children.forEach((child) => {
              if (child.nodeName !== "style" && child !== g) {
                g.appendChild(child);
              }
            });
            svg.appendChild(contentG);
          }
          const zoom = window.d3
            .zoom()
            .scaleExtent([0.1, 10])
            .on("zoom", (event: { transform: unknown }) => {
              contentG.setAttribute("transform", String(event.transform));
            });
          window.d3.select(svg).call(zoom);
        })
        .catch(() => showError(s("mindmap.chartError", "图表渲染失败")));
    })
    .catch(() => showError(s("mindmap.chartLoadFailed", "图表加载失败(网络?)")));
}

function buildMindmapPartEl(part: SerializablePart): HTMLElement {
  const card = el("div", "chart-card part-mindmap");
  card.style.background = varVal("--card", "#fdfaf0");
  card.style.border = "0.5px solid " + varVal("--border", "#e2d7ba");
  const header = el("div", "collapsible-header");
  header.appendChild(el("span", "header-text", part.title || s("mindmap.title", "思维导图")));
  card.appendChild(header);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as unknown as SVGSVGElement;
  svg.setAttribute("id", "mindmap-" + part.id);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "300");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.style.width = "100%";
  svg.style.height = "300px";
  svg.style.touchAction = "none";
  svg.style.cursor = "grab";
  card.appendChild(svg as unknown as HTMLElement);
  const hint = el("div", "chart-hint", s("mindmap.zoomHintMindmap", "双指缩放 · 拖动移动 · 点击节点展开/收起"));
  card.appendChild(hint);
  void part;
  renderMindmapInto(svg, part.title || "", part.markdown || "");
  return card;
}

function renderMindmapInto(svg: SVGSVGElement, title: string, markdown: string) {
  void title;
  injectScript(MARKMAP_SRC)
    .then(() => waitFor(() => Boolean(window.markmap && window.markmap.Transformer && window.markmap.Markmap), 15000))
    .then((ok) => {
      if (!ok) {
        postToRN("debug", { message: "mindmap lib load timeout" });
        return;
      }
      try {
        const Transformer = window.markmap.Transformer;
        const Markmap = window.markmap.Markmap;
        const transformer = new Transformer();
        const result = transformer.transform(markdown || "");
        Markmap.create(svg, {
          autoFit: true,
          duration: 300,
          maxWidth: 200,
          color: () => varVal("--primary", "#8a6d3b"),
        }, result.root);
        // 移动端触摸 pan/pinch(照搬 MindmapView installTouchPanFallback 语义)
        installTouchPanFallback(svg);
        postToRN("debug", { message: "mindmap-rendered" });
      } catch (err) {
        postToRN("debug", { message: "mindmap render error: " + String(err) });
      }
    })
    .catch(() => postToRN("debug", { message: "mindmap lib load failed" }));
}

/** markmap SVG 触摸兜底:单指 pan / 双指 pinch(简化自 MindmapView) */
function installTouchPanFallback(svg: SVGSVGElement) {
  if ((svg as unknown as { dataset?: Record<string, string> }).dataset?.touchFallback === "1") return;
  (svg as unknown as { dataset: Record<string, string> }).dataset ||= {};
  (svg as unknown as { dataset: Record<string, string> }).dataset.touchFallback = "1";

  let touchState: {
    type: string;
    start?: { x: number; y: number };
    center?: { x: number; y: number };
    distance?: number;
    transform: { x: number; y: number; k: number };
    moved: boolean;
  } | null = null;
  let suppressClickUntil = 0;

  const point = (t: Touch) => {
    const rect = svg.getBoundingClientRect();
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  };
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  const center = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

  const getTransform = () => {
    const g = svg.querySelector("g");
    if (!g) return { x: 0, y: 0, k: 1 };
    const t = (g as SVGGElement).transform?.baseVal?.consolidate();
    if (!t) return { x: 0, y: 0, k: 1 };
    return { x: t.matrix.e, y: t.matrix.f, k: t.matrix.a || 1 };
  };
  const applyTransform = (t: { x: number; y: number; k: number }) => {
    const g = svg.querySelector("g");
    if (g) g.setAttribute("transform", `translate(${t.x},${t.y}) scale(${t.k})`);
  };

  svg.addEventListener(
    "click",
    (e) => {
      if (Date.now() < suppressClickUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  svg.addEventListener(
    "touchstart",
    (e) => {
      if (!e.touches || e.touches.length === 0) return;
      const current = getTransform();
      if (e.touches.length === 1) {
        touchState = { type: "pan", start: point(e.touches[0]), transform: current, moved: false };
      } else {
        const a = point(e.touches[0]);
        const b = point(e.touches[1]);
        touchState = { type: "pinch", center: center(a, b), distance: dist(a, b), transform: current, moved: false };
      }
    },
    { passive: false },
  );
  svg.addEventListener(
    "touchmove",
    (e) => {
      if (!touchState || !e.touches || e.touches.length === 0) return;
      if (touchState.type === "pan" && e.touches.length === 1 && touchState.start) {
        const p = point(e.touches[0]);
        const dx = p.x - touchState.start.x;
        const dy = p.y - touchState.start.y;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) touchState.moved = true;
        applyTransform({ x: touchState.transform.x + dx, y: touchState.transform.y + dy, k: touchState.transform.k });
        e.preventDefault();
        e.stopPropagation();
      } else if (touchState.type === "pinch" && e.touches.length >= 2 && touchState.center && touchState.distance) {
        const a = point(e.touches[0]);
        const b = point(e.touches[1]);
        const c = center(a, b);
        const d = dist(a, b);
        const nextScale = clamp(touchState.transform.k * (d / touchState.distance), 0.2, 6);
        const ratio = nextScale / touchState.transform.k;
        touchState.moved = true;
        applyTransform({
          x: c.x - (touchState.center.x - touchState.transform.x) * ratio,
          y: c.y - (touchState.center.y - touchState.transform.y) * ratio,
          k: nextScale,
        });
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { passive: false },
  );
  svg.addEventListener("touchend", () => {
    if (touchState && touchState.moved) suppressClickUntil = Date.now() + 120;
    touchState = null;
  });
}

// ────────────────────────── 滚动与指示器 ──────────────────────────

/** 事件委托:cite-link [N] → postToRN('cite');(quote 卡在 buildQuoteBlockEl 已绑定) */
function initClickDelegates() {
  document.addEventListener(
    "click",
    (e) => {
      const t = e.target as Element | null;
      const link = t && t.closest ? t.closest("a.cite-link") : null;
      if (!link) return;
      e.preventDefault();
      const num = link.getAttribute("data-cite-idx");
      if (!num) return;
      const msgEl = link.closest(".msg");
      const msgId = msgEl ? msgEl.getAttribute("data-mid") : null;
      const citation = citationsByMsg.get(msgId || "")?.find(
        (c) => c.citationIndex === Number(num),
      );
      postToRN("cite", {
        messageId: msgId || "",
        partId: "",
        num,
        citation: citation || null,
      });
    },
    true,
  );
}

function initScroll() {
  listEl = document.getElementById("list") as HTMLDivElement;
  footerIndicatorEl = document.getElementById("footer-indicator") as HTMLDivElement;
  scrollPillEl = document.getElementById("scroll-down-pill") as HTMLDivElement;

  const BOTTOM_THRESHOLD = 80;
  listEl.addEventListener(
    "scroll",
    () => {
      const near = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < BOTTOM_THRESHOLD;
      rt.atBottom = near;
      scrollPillEl.style.display = near ? "none" : "block";
    },
    { passive: true },
  );
  scrollPillEl.addEventListener("click", () => {
    listEl.scrollTop = listEl.scrollHeight;
    rt.atBottom = true;
    scrollPillEl.style.display = "none";
  });

  const ro = new ResizeObserver(() => {
    if (rt.atBottom) {
      listEl.scrollTop = listEl.scrollHeight;
    }
  });
  ro.observe(listEl);
}

function refreshIndicators() {
  // footer indicator(流式状态 pill)
  const stepLabel = stepText(rt.step);
  footerIndicatorEl.style.display = rt.isStreaming && stepLabel ? "block" : "none";
  if (stepLabel) {
    footerIndicatorEl.innerHTML = "";
    footerIndicatorEl.appendChild(el("div", "step-pill", stepLabel));
  }
  // 气泡 gap 指示器:局部更新显隐(不重建消息,保持流式 append 的 DOM)
  for (const msg of stateMessages.values()) {
    const root = messagesEl.get(msg.id);
    if (!root) continue;
    const gap = root.querySelector(".gap-anchor");
    if (gap) {
      (gap as HTMLElement).style.display = showGapIndicator(msg) ? "inline-flex" : "none";
    }
  }
}

function stepText(step: string): string | null {
  switch (step) {
    case "thinking":
      return s("streaming.thinking", "正在思考...");
    case "tool_calling":
      return s("streaming.toolCalling", "正在调用工具...");
    case "responding":
      return s("streaming.responding", "正在回复...");
    default:
      return null;
  }
}

const stateMessages = new Map<string, SerializableMessage>();

function registerMessage(messageId: string, rootEl: HTMLElement, msg: SerializableMessage) {
  rootEl.setAttribute("data-mid", messageId);
  messagesEl.set(messageId, rootEl);
  const citations = sortCitationsByIndex(msg.parts.filter((p) => p.type === "citation"));
  citationsByMsg.set(messageId, citations);
  const byPart = new Map<string, PartEntry>();
  for (const part of msg.parts) {
    const partEl = rootEl.querySelector(`[data-pid="${CSS.escape(part.id)}"]`);
    if (partEl) {
      byPart.set(part.id, {
        el: partEl as HTMLElement,
        type: part.type,
        len: part.text ? part.text.length : 0,
      });
    }
  }
  partsByMsg.set(messageId, byPart);
  stateMessages.set(messageId, msg);
}

function unregisterMessage(messageId: string) {
  messagesEl.delete(messageId);
  partsByMsg.delete(messageId);
  citationsByMsg.delete(messageId);
  stateMessages.delete(messageId);
}

// ────────────────────────── 命令分派 ──────────────────────────

function cleanup() {
  listEl.innerHTML = "";
  messagesEl.clear();
  partsByMsg.clear();
  citationsByMsg.clear();
  stateMessages.clear();
  order.length = 0;
  richJobs.clear();
  if (richTimer !== null) {
    clearTimeout(richTimer);
    richTimer = null;
  }
}

function scrollBottom(force: boolean) {
  if (force || rt.atBottom) {
    listEl.scrollTop = listEl.scrollHeight;
    rt.atBottom = true;
    scrollPillEl.style.display = "none";
  }
}

// ────────────────────────── 分级富化(冷态→markdown,防首屏卡顿)──────────────────────────

interface RichJob {
  messageId: string;
  partId: string;
  text: string;
}

const richJobs = new Map<string, RichJob>(); // partId -> job
const richDone = new Set<string>(); // partId(已富化,防重复)
let richTimer: number | null = null;

function queueRich(messageId: string, partId: string, text: string) {
  if (richDone.has(partId) || richJobs.has(partId)) return;
  richJobs.set(partId, { messageId, partId, text });
  scheduleRich();
}

function scheduleRich() {
  if (richTimer !== null) return;
  richTimer = window.setTimeout(runRichBatch, 60);
}

function runRichBatch() {
  richTimer = null;
  // 底部(最新消息)优先:jobs 无序,重建按消息 order 倒序一次
  const msgs = Array.from(stateMessages.values());
  const partOrder = new Map<string, number>();
  msgs.forEach((m, i) => partOrder.set(m.id, i));
  const jobs = Array.from(richJobs.values()).sort(
    (a, b) => (partOrder.get(b.messageId) ?? 0) - (partOrder.get(a.messageId) ?? 0),
  );
  // 每批最多 3 条,60ms 一批(可见区 ≈ 底部 5-10 条在 1-2 批内富化完)
  const BATCH = 3;
  let doneCount = 0;
  for (const job of jobs) {
    if (doneCount >= BATCH) break;
    const msgEl = messagesEl.get(job.messageId);
    const partEl = msgEl?.querySelector(`[data-pid="${CSS.escape(job.partId)}"]`);
    const plainEl = partEl?.querySelector(".plain-pending");
    if (partEl && plainEl) {
      const frag = renderMarkdown(job.text, job.messageId);
      plainEl.replaceWith(frag);
      richDone.add(job.partId);
      richJobs.delete(job.partId);
      doneCount++;
    } else {
      // part 已被 upsert 重建/消失:放弃该 job
      richJobs.delete(job.partId);
    }
  }
  if (richJobs.size > 0) scheduleRich();
}

function dispatch(cmd: ChatCommand) {
  switch (cmd.type) {
    case "renderAll": {
      const messages = (cmd.messages as SerializableMessage[]) || [];
      cleanup();
      const frag = document.createDocumentFragment();
      for (const msg of messages) {
        try {
          const msgEl = buildMessageEl(msg);
          registerMessage(msg.id, msgEl, msg);
          frag.appendChild(msgEl);
        } catch (err) {
          // 单条渲染异常隔离,不中断整批(其余消息仍可显示)
          postToRN("error", { message: "message-render: " + String(err) });
        }
      }
      listEl.appendChild(frag);
      refreshIndicators();
      requestAnimationFrame(() => scrollBottom(true));
      break;
    }
    case "addBatch": {
      const messages = (cmd.messages as SerializableMessage[]) || [];
      // 整批构建(冷态纯文本零解析):一条命令跨桥,渲染仍同步快速
      const frag = document.createDocumentFragment();
      for (const msg of messages) {
        try {
          const msgEl = buildMessageEl(msg);
          registerMessage(msg.id, msgEl, msg);
          frag.appendChild(msgEl);
        } catch (err) {
          postToRN("error", { message: "addBatch-render: " + String(err) });
        }
      }
      listEl.appendChild(frag);
      refreshIndicators();
      requestAnimationFrame(() => scrollBottom(true));
      break;
    }
    case "upsertMessage": {
      const msg = cmd.message as SerializableMessage;
      try {
        const existing = messagesEl.get(msg.id);
        const fresh = buildMessageEl(msg);
        if (!fresh) {
          cleanup();
          break;
        }
        if (existing) {
          existing.replaceWith(fresh);
          unregisterMessage(msg.id);
        } else {
          listEl.appendChild(fresh);
        }
        registerMessage(msg.id, fresh, msg);
      } catch (err) {
        postToRN("error", { message: "upsert-render: " + String(err) });
        break;
      }
      scrollBottom(false);
      refreshIndicators();
      break;
    }
    case "streamUpdate": {
      const messageId = cmd.messageId as string;
      const partId = cmd.partId as string;
      const delta = (cmd.delta as string) || "";
      const byPart = partsByMsg.get(messageId);
      const entry = byPart?.get(partId);
      if (!entry) {
        // 未知 part(消息刚被 upsert 过):从 stateMessages 恢复
        const msg = stateMessages.get(messageId);
        if (msg) {
          const fresh = buildMessageEl(msg);
          (messagesEl.get(messageId) as HTMLElement | null)?.replaceWith(fresh);
          unregisterMessage(messageId);
          registerMessage(messageId, fresh, msg);
        }
        return;
      }
      if (entry.type === "text" || entry.type === "reasoning") {
        const target = entry.el.querySelector(
          entry.type === "text" ? ".part-text-plain" : ".reasoning-body-text",
        ) as HTMLElement | null;
        if (target) {
          target.appendChild(document.createTextNode(delta));
          entry.len += delta.length;
        }
        if (rt.atBottom) listEl.scrollTop = listEl.scrollHeight;
      }
      if (cmd.step) {
        rt.step = cmd.step as string;
        refreshIndicators();
      }
      break;
    }
    case "setStreaming": {
      rt.isStreaming = Boolean(cmd.isStreaming);
      rt.step = (cmd.step as string) || "idle";
      refreshIndicators();
      break;
    }
    case "setTheme": {
      const vars = (cmd.vars as Record<string, string>) || {};
      rt.vars = vars;
      const root = document.documentElement;
      for (const k of Object.keys(vars)) {
        root.style.setProperty(k, vars[k]);
      }
      break;
    }
    case "setLocale": {
      rt.strings = (cmd.strings as Record<string, string>) || {};
      rt.toolLabels = (cmd.toolLabels as Record<string, string>) || {};
      break;
    }
    case "setUi": {
      const pad = Number(cmd.bottomPad) || 120;
      document.documentElement.style.setProperty("--bottom-pad", pad + "px");
      break;
    }
    case "scrollToBottom": {
      scrollBottom(true);
      break;
    }
    case "clear": {
      cleanup();
      refreshIndicators();
      break;
    }
    case "ping": {
      postToRN("pong", {});
      break;
    }
    default:
      postToRN("debug", { message: "unknown command: " + cmd.type });
  }
}

// ────────────────────────── 入口 ──────────────────────────

function postToRN(type: string, data: Record<string, unknown>) {
  window.__postToRN?.(type, data);
}

function boot() {
  initScroll();
  initClickDelegates();
  window.__chat.dispatch = dispatch;
  window.__chat.flushQueue?.();
  postToRN("debug", { message: "chat-runtime booted, build=" + BUILD_ID });
  // 全部函数就绪后宣告 ready(照抄 reader ready 信标语义)
  postToRN("ready", {});
  booted = true;
}

const BUILD_ID = typeof __CHAT_BUILD_ID__ !== "undefined" ? __CHAT_BUILD_ID__ : "dev";

if (document.readyState === "complete") {
  boot();
} else {
  window.addEventListener("load", boot);
}
