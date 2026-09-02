/**
 * ResidentReaderView — App 级常驻阅读器 WebView(柱 2 核心)。
 *
 * 对标静读天下 ActivityTxt 单例:阅读器 foliate WebView 常驻 App 顶层、
 * 门禁期(!ready 占位)即挂载 —— reader.html 的 2MB bundle 执行从"首帧之后"
 * 提前到"首帧之前/期间";ReaderScreen 不再自建 WebView,接入本壳
 * (注入命令/消息转发/几何同步),退出阅读页不销毁 → 热路径秒开。
 *
 * 层级:壳渲染在 App() 顶层(I18nextProvider 树之前)→ 位于导航容器下层;
 * 阅读激活时 ReaderScreen 页面背景透明,书页从下层透出,悬浮 UI 仍在导航层。
 * 隐藏时(geometry=null)零尺寸 + pointerEvents none,不影响任何页面。
 */
import { Asset } from "expo-asset";
import { useEffect, useState } from "react";
import {
  Dimensions,
  NativeModules,
  PixelRatio,
  StyleSheet,
  View,
} from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { getReaderHtmlUriSync, preloadReaderHtmlAsset } from "@/lib/reader/reader-html-asset";
import { getPlatformService } from "@readany/core";

const READER_HTML_ASSET = Asset.fromModule(require("../../../assets/reader/reader.html"));

/** 阅读几何:由 ReaderScreen 依当前布局算好(原 WebView 的 marginTop/height) */
export interface ReaderGeometry {
  marginTop: number;
  height: number;
}

/** 壳当前状态快照:ReaderScreen 挂载时补偿"挂载前已发生"的消息(foliate-ready/relocate/toc) */
export interface ResidentReaderSnapshot {
  htmlUri: string | null;
  foliateReady: boolean;
  openBookedBookId: string | null;
  bookReadyFor: string | null;
  lastRelocate: Record<string, unknown> | null;
  lastToc: Array<Record<string, unknown>> | null;
}

type SnapshotListener = (s: ResidentReaderSnapshot) => void;
type FoliateReadyListener = () => void;

class ResidentReaderController {
  private webView: WebView | null = null;
  /** 转发给 ReaderScreen 桥的处理器:直接给原始 data 字符串(与 WebView onMessage 一致) */
  private messageHandler: ((raw: string) => void) | null = null;
  private geometry: ReaderGeometry | null = null;
  private interactive = false;

  private foliateReady = false;
  private openBookedBookId: string | null = null;
  private bookReadyFor: string | null = null;
  private lastRelocate: Record<string, unknown> | null = null;
  private lastToc: Array<Record<string, unknown>> | null = null;

  private snapshotListeners = new Set<SnapshotListener>();
  private geometryListeners = new Set<(g: ReaderGeometry | null) => void>();
  private interactiveListeners = new Set<(v: boolean) => void>();
  private foliateReadyListeners = new Set<FoliateReadyListener>();
  private recreateListeners = new Set<() => void>();

  // ── 组件回调 ───────────────────────────────────────────────
  attachWebView(wv: WebView | null): void {
    this.webView = wv;
    // 【柱2 关键修复】WebView 就绪即补推触摸状态:ReaderScreen 的 showReader
    // 常在 WebView 就绪之前触发(htmlUri 未下载完)→ 旧逻辑 setActive 停在 false;
    // attach 成功后再推一次,转发即刻打开
    if (wv) {
      this.applyTouchState();
    }
  }

  /** 页面消息入口:先记录状态,再把原始消息交给当前注册的 ReaderScreen 桥处理器 */
  handlePageMessage(raw: string): void {
    let msg: Record<string, unknown> | null = null;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // 非 JSON 消息:仍转发(桥自己再解析处理)
      this.messageHandler?.(raw);
      return;
    }
    switch (msg.type) {
      case "ready":
      case "foliate-loaded":
        if (this.foliateReady) break;
        this.foliateReady = true;
        this.emitSnapshot();
        this.fireFoliateReady();
        break;
      case "bookReady":
        this.bookReadyFor = this.openBookedBookId;
        this.emitSnapshot();
        break;
      case "toc":
        if (Array.isArray(msg.items)) this.lastToc = msg.items as Array<Record<string, unknown>>;
        break;
      case "relocate":
        this.lastRelocate = msg;
        break;
      default:
        break;
    }
    // 转发给桥(bridge.handleMessage 接收 WebView onMessage 事件,给原始字符串)
    try {
      this.messageHandler?.(raw);
    } catch (err) {
      console.warn("[ResidentReaderView] message handler threw:", err);
    }
  }

  /** ReaderScreen 挂载后把完整消息处理器交到这里(含 ready/bookReady/relocate/toc…)。 */
  setMessageHandler(fn: ((raw: string) => void) | null): void {
    this.messageHandler = fn;
  }

  // ── 事件订阅 ───────────────────────────────────────────────
  subscribeSnapshot(fn: SnapshotListener): () => void {
    this.snapshotListeners.add(fn);
    fn(this.snapshot());
    return () => this.snapshotListeners.delete(fn);
  }

  subscribeGeometry(fn: (g: ReaderGeometry | null) => void): () => void {
    this.geometryListeners.add(fn);
    fn(this.geometry);
    return () => this.geometryListeners.delete(fn);
  }

  subscribeInteractive(fn: (v: boolean) => void): () => void {
    this.interactiveListeners.add(fn);
    fn(this.interactive);
    return () => this.interactiveListeners.delete(fn);
  }

  /** 壳就绪回调:已就绪则立即触发;否则待首次 ready/foliate-loaded */
  onFoliateReady(fn: FoliateReadyListener): () => void {
    if (this.foliateReady) {
      fn();
      return () => {};
    }
    this.foliateReadyListeners.add(fn);
    return () => this.foliateReadyListeners.delete(fn);
  }

  subscribeRecreate(fn: () => void): () => void {
    this.recreateListeners.add(fn);
    return () => this.recreateListeners.delete(fn);
  }

  // ── 阅读器 API(ReaderScreen 使用)───────────────────────────
  snapshot(): ResidentReaderSnapshot {
    return {
      htmlUri: getReaderHtmlUriSync(),
      foliateReady: this.foliateReady,
      openBookedBookId: this.openBookedBookId,
      bookReadyFor: this.bookReadyFor,
      lastRelocate: this.lastRelocate,
      lastToc: this.lastToc,
    };
  }

  /** 显示壳(进入阅读器并设定书页几何) */
  showReader(geometry: ReaderGeometry): void {
    this.geometry = geometry;
    for (const fn of this.geometryListeners) fn(this.geometry);
    this.applyTouchState();
  }

  /** 隐藏壳(退出阅读器) */
  hideReader(): void {
    this.geometry = null;
    this.interactive = false;
    for (const fn of this.geometryListeners) fn(this.geometry);
    for (const fn of this.interactiveListeners) fn(this.interactive);
    this.applyTouchState();
  }

  /** 书页是否可触摸(面板打开时 false,与原 WebView pointerEvents 语义一致) */
  setInteractive(v: boolean): void {
    if (this.interactive === v) return;
    this.interactive = v;
    for (const fn of this.interactiveListeners) fn(this.interactive);
    this.applyTouchState();
  }

  /**
   * 柱2(TouchForwarder):阅读激活且可触摸时,把书页矩形(屏幕物理像素)
   * 与激活开关推给原生模块——ReactRootView 将矩形内触摸直转壳 WebView。
   */
  private applyTouchState(): void {
    const TF = NativeModules.TouchForwarder as {
      setActive?: (v: boolean) => void;
      setRect?: (l: number, t: number, r: number, b: number) => void;
    } | undefined;
    if (!TF?.setActive) return;
    if (this.interactive && this.geometry && this.webView) {
      const density = PixelRatio.get();
      const top = this.geometry.marginTop * density;
      const bottom = (this.geometry.marginTop + this.geometry.height) * density;
      const right = Dimensions.get("window").width * density;
      try {
        TF.setActive(true);
        TF.setRect?.(0, top, right, bottom);
      } catch {
        // 忽略:模块缺失时静默(与旧 WebView pointerEvents 兜底一致)
      }
    } else {
      TF.setActive(false);
    }
  }

  /** ReaderScreen 打开书(记录 bookId;命令本体不含 bookId,模板侧会忽略多余字段) */
  openBook(bookId: string, params: Record<string, unknown>): void {
    const { bookId: _drop, ...clean } = params;
    this.openBookedBookId = bookId;
    this.bookReadyFor = null;
    this.lastRelocate = null;
    this.lastToc = null;
    this.emitSnapshot();
    this.webView?.injectJavaScript(
      `handleCommand(${JSON.stringify({ type: "openBook", ...clean })}); true;`,
    );
  }

  /** 任意 JS 注入(壳内 WebView;读者桥的底层原语) */
  inject(code: string): void {
    this.webView?.injectJavaScript(code);
  }

  /** 自愈:重建壳 WebView(ReaderScreen 超时触发或内容进程被杀) */
  recreate(): void {
    this.foliateReady = false;
    this.bookReadyFor = null;
    this.emitSnapshot();
    for (const fn of this.recreateListeners) fn();
  }

  private emitSnapshot(): void {
    const s = this.snapshot();
    for (const fn of this.snapshotListeners) fn(s);
  }

  private fireFoliateReady(): void {
    for (const fn of this.foliateReadyListeners) fn();
    this.foliateReadyListeners.clear();
  }
}

/** App 级单例 */
export const residentReader = new ResidentReaderController();

/**
 * 壳组件:常驻渲染单个 WebView(配置与旧 ReaderScreen WebView 一致),
 * 由 residentReader 单例连接 ReaderScreen。组件自身无业务状态。
 */
export function ResidentReaderView() {
  const [htmlUri, setHtmlUri] = useState<string | null>(() => getReaderHtmlUriSync());
  const [geometry, setGeometry] = useState<ReaderGeometry | null>(null);
  const [interactive, setInteractive] = useState(false);
  const [epoch, setEpoch] = useState(0);

  // asset 就绪(预下载与 App bootstrap 并行;release 内置资产秒取)
  useEffect(() => {
    if (!htmlUri) {
      preloadReaderHtmlAsset()
        .then(() => setHtmlUri(getReaderHtmlUriSync()))
        .catch((e: any) => {
          console.log("[ResidentReaderView] preload asset FAILED:", String(e?.message ?? e));
          // 重试一次(dev 下首次下载偶发失败)
          setTimeout(() => {
            preloadReaderHtmlAsset()
              .then(() => setHtmlUri(getReaderHtmlUriSync()))
              .catch((e2: any) => console.log("[ResidentReaderView] retry FAILED:", String(e2?.message ?? e2)));
          }, 3000);
        });
    }
  }, [htmlUri]);

  // 组件与单例连接
  useEffect(() => {
    const unsubGeometry = residentReader.subscribeGeometry(setGeometry);
    const unsubInteractive = residentReader.subscribeInteractive(setInteractive);
    const unsubRecreate = residentReader.subscribeRecreate(() => setEpoch((e) => e + 1));
    return () => {
      unsubGeometry();
      unsubInteractive();
      unsubRecreate();
    };
  }, []);

  if (!htmlUri) return null;

  return (
    <View
      style={[
        s.host,
        geometry
          ? { top: geometry.marginTop, height: geometry.height }
          : { width: 0, height: 0, opacity: 0 },
      ]}
      pointerEvents={geometry && interactive ? "auto" : "none"}
    >
      <WebView
        key={`resident-reader-wv-${epoch}`}
        ref={(wv) => {
          // 同时喂给 ReaderScreen 桥的 webViewRef(注入命令走它)与控制器;
          // 触摸转发的 target 由原生层(ReactRootView)按 WebView 视图类递归寻找
          residentReaderWebViewRef.current = wv;
          residentReader.attachWebView(wv);
        }}
        source={{ uri: htmlUri }}
        style={s.webview}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        cacheEnabled={false}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        allowsInlineMediaPlayback
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        mixedContentMode="always"
        onMessage={(event: WebViewMessageEvent) => {
          residentReader.handlePageMessage(event.nativeEvent.data);
        }}
        onError={(e) => {
          console.error("[ResidentReaderView] WebView error:", e.nativeEvent);
        }}
        onHttpError={(e) => {
          console.error("[ResidentReaderView] WebView HTTP error:", e.nativeEvent);
        }}
        onContentProcessDidTerminate={() => {
          console.warn("[ResidentReaderView] WebView content process terminated");
          // 内容进程被杀:重建(同 ReaderScreen 旧自愈逻辑)
          residentReader.recreate();
        }}
        onTouchStart={() => {
        }}
        onTouchEnd={() => {
          // 物理松手信号 → webview(RN 触摸层与选区句柄独立,松手必然可达)
          residentReader.inject(
            "window.__readanyOnRelease && window.__readanyOnRelease(); true;",
          );
        }}
      />
    </View>
  );
}

/** 全宽 + 几何控制(高度/顶部由 ReaderScreen 计算) */
const s = StyleSheet.create({
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    overflow: "hidden",
  },
  webview: { flex: 1 },
});

/** WebView ref 兼容层:useReaderBridge 需要注入 `webViewRef` */
export const residentReaderWebViewRef: { current: WebView | null } = { current: null };

/**
 * A3:壳 bundle 就绪后预打开恢复书(冷启动书内直达时解析提前到导航出现前)。
 * 失败仅 warn——ReaderScreen 的正常 openBook 路径兜底。
 */
export async function preloadResumeBook(): Promise<void> {
  const { useResumeStore } = await import("@/stores/resume-store");
  // resume store 的 hydration(持久化恢复)与壳加载并行进行:
  // 壳就绪时可能尚未恢复——等它一下(上限 1s,等不到就当无恢复书)
  const deadline = Date.now() + 1000;
  while (!useResumeStore.getState()._hasHydrated && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const bookId = useResumeStore.getState().activeReaderBookId;
  if (!bookId) return;
  const { getBook } = await import("@readany/core/db/database");
  const book = await getBook(bookId, { includeDeleted: true });
  if (!book?.filePath || !book?.format) return;
  const platform = getPlatformService();
  const appData = await platform.getAppDataDir();
  const { startFileServer } = await import("@/lib/reader/local-file-server");
  const fileName = book.filePath.split("/").pop() || "book.epub";
  const mime =
    book.format === "pdf"
      ? "application/pdf"
      : book.format === "txt"
        ? "text/plain"
        : "application/epub+zip";
  const encodedPath = book.filePath
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  const serverUrl = await startFileServer(appData);
  residentReader.openBook(bookId, {
    uri: `${serverUrl}/${encodedPath}`,
    fileName,
    mimeType: mime,
    lastLocation: book.currentCfi || undefined,
  });
}
