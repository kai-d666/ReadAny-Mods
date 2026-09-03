import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { BookmarkRibbon } from "@/components/reader/BookmarkRibbon";
import { ChapterTranslationSheet } from "@/components/reader/ChapterTranslationSheet";
import { ReadingProgressSlider } from "@/components/reader/ReadingProgressSlider";
import { SelectionPopover } from "@/components/reader/SelectionPopover";
import { TTSPage } from "@/components/reader/TTSPage";
import { TranslationPanel } from "@/components/reader/TranslationPanel";
import {
  BookmarkFilledIcon,
  BookmarkIcon,
  BotIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  HeadphonesIcon,
  LanguagesIcon,
  NotebookPenIcon,
  SearchIcon,
  XIcon,
} from "@/components/ui/Icon";
import { SyncButton } from "@/components/ui/SyncButton";
import { useReaderBridge } from "@/hooks/use-reader-bridge";
import type { RelocateEvent, SelectionEvent, VisibleTTSSegment } from "@/hooks/use-reader-bridge";
import {
  DEFAULT_DICTIONARY_KEY,
  DictionaryNotInstalledError,
  DictionaryOptionNotConfiguredError,
  launchDictionary,
} from "@/lib/dictionary-intents";
import { LookupModal } from "@/components/reader/LookupModal";
import { translateBuiltin, type BuiltinLookupMode } from "@/lib/dictionary-lookup";
import { startFileServer } from "@/lib/reader/local-file-server";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import {
  useAnnotationStore,
  useLibraryStore,
  useReaderStore,
  useReadingSessionStore,
  useSettingsStore,
  useTTSStore,
} from "@/stores";
import { useChatStore } from "@/stores/chat-store";
import { useMissingBookPromptStore } from "@/stores/missing-book-prompt-store";
import { useResumeStore } from "@/stores/resume-store";
import { useTheme } from "@/styles/ThemeContext";
import { useColors, withOpacity } from "@/styles/theme";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { readingContextService } from "@readany/core/ai/reading-context-service";
import { runWithDbRetry } from "@readany/core/db/write-retry";
import { useChapterTranslation } from "@readany/core/hooks";
import { useReadingSession } from "@readany/core/hooks/use-reading-session";
import { getPlatformService } from "@readany/core/services";
import { getCSSFontFace, useFontStore } from "@readany/core/stores";
import type { Book, ReadSettings, TOCItem } from "@readany/core/types";
import { getBook } from "@readany/core/db/database";
import {
  getReadingProgressForBook,
  saveReadingProgressForBook,
} from "@readany/core/db/progress-queries";
import { eventBus } from "@readany/core/utils/event-bus";
import { throttle } from "@readany/core/utils/throttle";
import * as DocumentPicker from "expo-document-picker";
import * as NavigationBar from "expo-navigation-bar";
/**
 * ReaderScreen — WebView-based reader with foliate-js engine.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  BackHandler,
  type AppStateStatus,
  Easing,
  Modal,
  NativeModules,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
  Dimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

// ── Extracted modules ──
import { ReaderNoteViewModal } from "./reader/ReaderNoteViewModal";

const REFLOWABLE_CHARACTERS_PER_LOCATION = 1500;
// 屏幕物理全尺寸(竖屏锁定,恒定)。vivo 上 useWindowDimensions 在沉浸模式切换后
// 不更新(停在"全屏减系统栏"旧值),导致按窗口高算出的 WebView 底部留白;
// screenH 恒为屏幕全高,阅读器 WebView 用它做高度基准
const screenHeight = Dimensions.get("screen").height;
const MAX_TRACKED_LOCATION_DELTA = 20;
const MAX_TRACKED_PAGE_DELTA = 20;
const MAX_TRACKED_FRACTION_DELTA = 0.08;
const INITIAL_PROGRESS_RESTORE_GUARD_MS = 1800;
const PROGRAMMATIC_NAV_GUARD_MS = 1200;
const BOOK_MIME_TYPES = [
  "application/epub+zip",
  "application/pdf",
  "application/x-mobipocket-ebook",
  "application/vnd.amazon.ebook",
  "application/vnd.comicbook+zip",
  "application/x-fictionbook+xml",
  "text/plain",
  "application/octet-stream",
];

const BOOK_FORMAT_MIME_TYPES: Partial<Record<string, string>> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  mobi: "application/x-mobipocket-ebook",
  azw: "application/vnd.amazon.ebook",
  azw3: "application/vnd.amazon.ebook",
  cbz: "application/vnd.comicbook+zip",
  cbr: "application/vnd.comicbook+zip",
  fb2: "application/x-fictionbook+xml",
  fbz: "application/x-zip-compressed-fb2",
  txt: "text/plain",
};

function normalizeBookIdentityText(value?: string): string {
  return (value || "").toLowerCase().replace(/[\s\p{P}\p{S}_-]+/gu, "");
}

function authorsLikelyMatch(a?: string, b?: string): boolean {
  const left = normalizeBookIdentityText(a);
  const right = normalizeBookIdentityText(b);
  if (!left || !right) return true;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const leftParts = left.split(/[,，、/&]+/).filter((part) => part.length > 1);
  const rightParts = right.split(/[,，、/&]+/).filter((part) => part.length > 1);
  return leftParts.some((part) =>
    rightParts.some((candidate) => part.includes(candidate) || candidate.includes(part)),
  );
}

function shouldConfirmReimportCandidate(
  originalBook: { meta: { title: string; author: string }; format: string; fileHash?: string },
  candidate: { title: string; author: string; format: string; fileHash?: string },
): boolean {
  if (candidate.fileHash && originalBook.fileHash && candidate.fileHash === originalBook.fileHash) {
    return false;
  }
  const originalTitle = normalizeBookIdentityText(originalBook.meta.title);
  const candidateTitle = normalizeBookIdentityText(candidate.title);
  const titleMismatch =
    !!originalTitle &&
    !!candidateTitle &&
    originalTitle !== candidateTitle &&
    !originalTitle.includes(candidateTitle) &&
    !candidateTitle.includes(originalTitle);
  const authorMismatch = !authorsLikelyMatch(originalBook.meta.author, candidate.author);
  const formatMismatch = originalBook.format !== candidate.format;
  return titleMismatch || (formatMismatch && authorMismatch);
}
const NOTE_TOOLTIP_WIDTH = 300;
const NOTE_TOOLTIP_SIDE_PADDING = 12;
const NOTE_TOOLTIP_ABOVE_OFFSET = 2;
const NOTE_TOOLTIP_BELOW_OFFSET = 8;
const NOTE_TOOLTIP_TOP_THRESHOLD = 180;
import { useRubyStore } from "@readany/core/stores/ruby-store";
import { ReaderSettingsPanel } from "./reader/ReaderSettingsPanel";
import { ReaderTOCPanel } from "./reader/ReaderTOCPanel";
import {
  CONTROLS_TIMEOUT,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
} from "./reader/reader-constants";
import { BatteryIcon, ListIcon, SettingsIcon } from "./reader/reader-icons";
import { ReaderBottomInfoBar } from "./reader/ReaderBottomInfoBar";
import { makeStyles, noteTooltipMdStyles } from "./reader/reader-styles";
import { useReaderBookmark } from "./reader/useReaderBookmark";
import { useReaderSearch } from "./reader/useReaderSearch";
import { useReaderSystemInfo } from "./reader/useReaderSystemInfo";
import { useReaderTTS } from "./reader/useReaderTTS";
import { useVolumeButtonPaging } from "./reader/useVolumeButtonPaging";

import { getReaderHtmlUri, getReaderHtmlUriSync } from "@/lib/reader/reader-html-asset";
const LOCAL_FONT_SERVER_DIR = "readany-fonts";

type Props = NativeStackScreenProps<RootStackParamList, "Reader">;
type TTSSegment = VisibleTTSSegment;

// ──────────────────────────── helpers ────────────────────────────

function buildCustomFontFaceCSS(
  fonts: import("@readany/core/types/font").CustomFont[],
  selectedFontId: string | null,
  localServerUrl?: string | null,
): string {
  if (!selectedFontId) return "";
  const platform = getPlatformService();
  return fonts
    .filter((f) => f.id === selectedFontId)
    .map((f) => {
      // CSS-based remote fonts: @import into the reader iframe
      if (f.source === "remote" && f.remoteCssUrl) {
        return `@import url('${f.remoteCssUrl}');`;
      }
      if (f.source === "remote") return getCSSFontFace(f);
      if (!f.filePath) return "";
      const fileUrl = localServerUrl
        ? `${localServerUrl.replace(/\/$/, "")}/${LOCAL_FONT_SERVER_DIR}/${encodeURIComponent(f.fileName)}`
        : platform.convertFileSrc(f.filePath);
      const cssFormat =
        f.format === "otf"
          ? "opentype"
          : f.format === "woff"
            ? "woff"
            : f.format === "woff2"
              ? "woff2"
              : "truetype";
      return `@font-face {\n  font-family: ${JSON.stringify(f.fontFamily)};\n  src: url('${fileUrl}') format('${cssFormat}');\n  font-weight: normal;\n  font-style: normal;\n}`;
    })
    .filter(Boolean)
    .join("\n");
}

// ──────────────────────────── ReaderScreen ────────────────────────────
export function ReaderScreen({ route, navigation }: Props) {
  const colors = useColors();
  const { mode: themeMode } = useTheme();
  // makeStyles 每次调用新建几百个样式对象,必须缓存,否则每次渲染都在重建样式表
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { bookId, cfi, highlight: shouldHighlight, openTTS } = route.params;
  const { t, i18n } = useTranslation();

  // 启动恢复打点:进入阅读器记 bookId(App 被杀也持久化),离开(pop)清空
  useEffect(() => {
    useResumeStore.getState().setActiveReader(bookId);
    return () => {
      useResumeStore.getState().setActiveReader(null);
    };
  }, [bookId]);

  // 系统返回键兜底:启动恢复「直达书内」时栈中只有本屏,容器级 back handler
  // 因 canGoBack()=false 不拦截 BACK,系统直接退出 app(用户实测特例)。
  // 这里接管:无下级可退时改为回书库(栈重置为 [Tabs],与正常退出行为一致),
  // 有下级时返回 false 交给容器默认 goBack。
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (navigation.canGoBack()) return false;
      navigation.reset({ routes: [{ name: "Tabs" }] });
      return true;
    });
    return () => sub.remove();
  }, [navigation]);
  const isWideLayout = SCREEN_WIDTH >= 768;
  const isIPadLayout = Platform.OS === "ios" && Platform.isPad;
  const baseTopInset = Platform.OS === "ios" ? 20 : 24;

  // State
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(false);
  const [showTOC, setShowTOC] = useState(false);
  const [tocActiveTab, setTocActiveTab] = useState<"toc" | "bookmarks">("toc");
  const [showSettings, setShowSettings] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showNotebook, setShowNotebook] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  const [translationText, setTranslationText] = useState("");
  const [showTTS, setShowTTS] = useState(false);
  const [showChapterTranslation, setShowChapterTranslation] = useState(false);
  const [isReimporting, setIsReimporting] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [progress, setProgress] = useState(0);
  const [currentChapter, setCurrentChapter] = useState("");
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [toc, setToc] = useState<TOCItem[]>([]);
  const [bookTitle, setBookTitle] = useState("");
  const [webViewReady, setWebViewReady] = useState(false);
  // 自愈:WebView 在转场动画期间创建时,Android 可能跳过 JS 初始化(ready 永不发,
  // 表现为一直转圈)。挂载后 8s 未 ready 则重建 WebView(此时页面已稳定,必成功)。
  const [webViewEpoch, setWebViewEpoch] = useState(0);
  const webViewReadyRef = useRef(false);
  const [translationReady, setTranslationReady] = useState(false);
  // 惰性初始化:asset 已预下载(冷启动后),WebView 首帧即可创建,不等 effect
  const [readerHtmlUri, setReaderHtmlUri] = useState<string | null>(() => getReaderHtmlUriSync());
  // 首渲染只保留 WebView + loading overlay:界面装饰(工具栏/信息条/浮动工具等)
  // 延迟 400ms 挂载,大幅缩小首渲染组件树 → 点书到阅读页出现更快
  const [chromeReady, setChromeReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setChromeReady(true), 400);
    return () => clearTimeout(t);
  }, []);
  const [currentCfi, setCurrentCfi] = useState("");
  const [selection, setSelection] = useState<SelectionEvent | null>(null);
  const [fontServerUrl, setFontServerUrl] = useState<string | null>(null);
  const [noteViewHighlight, setNoteViewHighlight] = useState<{
    id: string;
    text: string;
    note?: string;
    cfi: string;
    color: string;
  } | null>(null);
  const [noteViewEditing, setNoteViewEditing] = useState(false);
  const [noteViewContent, setNoteViewContent] = useState("");
  const [noteTooltip, setNoteTooltip] = useState<{
    note: string;
    cfi: string;
    position: { x: number; y: number; selectionTop: number; selectionBottom: number };
  } | null>(null);
  const noteTooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteTooltipVisibleRef = useRef(false);
  const suppressReaderTapUntilRef = useRef(0);
  const assetLoadedRef = useRef(false);
  // Mediator ref so onRelocate can fire TTS continuation without direct hook dependency
  const ttsPendingContinueRef = useRef<{
    pendingTTSContinueCallbackRef: React.RefObject<(() => void) | null>;
    pendingTTSContinueSafetyTimerRef: React.RefObject<ReturnType<typeof setTimeout> | null>;
  } | null>(null);

  const bridgeRef = useRef<{
    requestPageSnippet: () => void;
    goNext: () => void;
    search: (query: string) => void;
    clearSearch: () => void;
    navigateSearch: (index: number) => void;
    getVisibleText: () => Promise<string>;
    getVisibleTTSSegments: (alignCfi?: string | null) => Promise<TTSSegment[]>;
    getChapterParagraphs: () => Promise<Array<{ id: string; text: string; tagName: string }>>;
    getTTSSegmentContext: (
      cfi: string,
      before?: number,
      after?: number,
    ) => Promise<{ before: TTSSegment[]; after: TTSSegment[] }>;
    getHrefTTSSegments?: (href: string, count?: number) => Promise<TTSSegment[]>;
    getSectionTTSSegments?: (sectionIndex: number, count?: number) => Promise<TTSSegment[]>;
    goToFraction: (fraction: number) => void;
    goToSection: (sectionIndex: number) => void;
    goToCFI: (cfi: string) => void;
    goToHref: (href: string) => void;
    flashHighlight: (cfi: string, color?: string, duration?: number) => void;
    addAnnotation: (annotation: {
      value: string;
      type?: string;
      color?: string;
      note?: string;
    }) => void;
    removeAnnotation: (annotation: { value: string; type?: string }) => void;
    setTTSHighlight: (cfi: string | null, color?: string, force?: boolean) => void;
  } | null>(null);

  // Chapter translation state
  const [currentSectionIndex, setCurrentSectionIndex] = useState(0);
  const chapterTranslationBridgeRef = useRef<{
    getChapterParagraphs: () => Promise<Array<{ id: string; text: string; tagName: string }>>;
    injectChapterTranslations: (
      results: Array<{ paragraphId: string; originalText: string; translatedText: string }>,
      visibility?: { originalVisible: boolean; translationVisible: boolean },
    ) => Promise<void>;
    removeChapterTranslations: () => void;
  } | null>(null);

  const readSettings = useSettingsStore((s) => s.readSettings);
  const updateReadSettings = useSettingsStore((s) => s.updateReadSettings);
  const translationConfig = useSettingsStore((s) => s.translationConfig);
  const aiConfig = useSettingsStore((s) => s.aiConfig);
  const showTopTitleProgress = readSettings.showTopTitleProgress !== false;
  const showBottomTimeBattery = readSettings.showBottomTimeBattery !== false;

  // Track OS-level accessibility font scale; re-renders when the user
  // changes the system font size while the reader is open.
  const { fontScale: systemFontScale, height: windowHeight } = useWindowDimensions();
  // Apply the system scale only when the user has opted into
  // followSystemFontScale. The store keeps the user's raw fontSize, so
  // toggling the option (or changing OS font size) doesn't drift the
  // stepper value.
  const computeEffectiveFontSize = useCallback(
    (rawFontSize: number, follow: boolean | undefined): number =>
      follow ? Math.max(1, Math.round(rawFontSize * systemFontScale)) : rawFontSize,
    [systemFontScale],
  );

  // Custom fonts — build @font-face CSS per-font using individual filePath
  const customFonts = useFontStore((s) => s.fonts);
  const selectedFontId = useFontStore((s) => s.selectedFontId);
  const customFontFamily = useMemo(() => {
    if (!selectedFontId) return "";
    return customFonts.find((f) => f.id === selectedFontId)?.fontFamily ?? "";
  }, [customFonts, selectedFontId]);
  const customFontFaceCSS = useMemo(
    () => buildCustomFontFaceCSS(customFonts, selectedFontId, fontServerUrl),
    [customFonts, selectedFontId, fontServerUrl],
  );

  const controlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const TOOLBAR_HIDE_OFFSET = 100;
  const toolbarAnim = useRef(new Animated.Value(TOOLBAR_HIDE_OFFSET)).current;
  const readerPullAnim = useRef(new Animated.Value(0)).current;
  const lastCfiRef = useRef<string>("");
  const progressRef = useRef(0);
  const locationHistoryRef = useRef<string[]>([]);
  const lastNavigatedCfiRef = useRef<string | undefined>(undefined);
  const fileServerRef = useRef<string | null>(null);
  const sessionProgressRef = useRef<{
    mode: "location" | "page" | "characters";
    current: number;
    fraction?: number;
    section?: number;
    page?: number;
  } | null>(null);
  const totalBookCharactersRef = useRef<number | null>(null);
  const progressTrackingGuardUntilRef = useRef(0);

  const incrementPagesRead = useReadingSessionStore((s) => s.incrementPagesRead);
  const incrementCharactersRead = useReadingSessionStore((s) => s.incrementCharactersRead);
  const { sendEvent } = useReadingSession(bookId); // Added useReadingSession hook
  const { books, updateBook } = useLibraryStore();
  const setGoToCfiFn = useReaderStore((s) => s.setGoToCfiFn);

  // Throttled progress save (same as desktop - 5 seconds)
  const throttledSaveProgress = useRef(
    throttle((bId: string, prog: number, cfi: string) => {
      updateBook(bId, {
        progress: prog,
        currentCfi: cfi,
      });
      // 跨设备进度:reading_progress 按内容哈希(同步重构,书行不再搬,
      // 进度靠 hash 认亲,Koodo 式,2026-09-03)
      void saveReadingProgressForBook(bId, { cfi, percent: prog }).catch((err: Error) =>
        console.error("Failed to save reading progress:", err),
      );
    }, 5000),
  ).current;
  const {
    loadAnnotations,
    highlights,
    removeBookmark,
  } = useAnnotationStore();
  // book 优先取 store(实时进度/删除标记);启动恢复直达时书库可能尚未加载,
  // store 未命中则从 DB 一次性兜底(加载完成后 store 出现,自动切换回 store)
  const storeBook = useMemo(() => books.find((b) => b.id === bookId), [books, bookId]);
  const [dbBook, setDbBook] = useState<Book | null>(null);
  useEffect(() => {
    if (storeBook) {
      setDbBook(null);
      return;
    }
    let stale = false;
    getBook(bookId, { includeDeleted: true })
      .then((b) => {
        if (!stale) setDbBook(b ?? null);
      })
      .catch(() => {
        if (!stale) setDbBook(null);
      });
    return () => {
      stale = true;
    };
  }, [bookId, storeBook]);
  const book = storeBook ?? dbBook;

  // ── System info (clock/battery/statusBar/SafeArea) ─────────────────────────
  // 状态栏随 UI 可见性:控制栏或任一面板打开 → 显示;纯阅读 → 隐藏(组件式 StatusBar,见下方 JSX)
  const readerChromeVisible =
    showControls || showTOC || showSettings || showSearch || showNotebook || showTranslation;
  const { readerClock, batteryLevel, isBatteryCharging, stableTopInset, insets } =
    useReaderSystemInfo({ isIPadLayout, baseTopInset });

  // 系统栏(状态栏+三键)一次调用同步显隐(自研 ReaderSystemBars 模块):
  // 双栏合入单个系统动画;面板切换点已先行调用(见 toggleControls),此处按状态兜底
  const readerSystemBarsRef = useRef<{ setEnabled?: (v: boolean) => void }>(
    NativeModules.ReaderSystemBars as never,
  );
  useEffect(() => {
    readerSystemBarsRef.current?.setEnabled?.(readerChromeVisible);
  }, [readerChromeVisible]);
  // 退出阅读器恢复系统栏
  useEffect(() => {
    return () => {
      readerSystemBarsRef.current?.setEnabled?.(true);
    };
  }, []);

  // ── Bookmark ───────────────────────────────────────────────────────────────
  const bookmark = useReaderBookmark({
    bookId,
    currentCfi,
    currentChapter,
    requestPageSnippet: () => bridgeRef.current?.requestPageSnippet(),
  });
  const { isBookmarked, bookBookmarks, handleToggleBookmark } = bookmark;

  const suppressProgressTracking = useCallback((duration = PROGRAMMATIC_NAV_GUARD_MS) => {
    progressTrackingGuardUntilRef.current = Math.max(
      progressTrackingGuardUntilRef.current,
      Date.now() + duration,
    );
  }, []);

  const goToCFISafely = useCallback(
    (targetCfi: string) => {
      if (!targetCfi) return;
      suppressProgressTracking();
      bridgeRef.current?.goToCFI(targetCfi);
    },
    [suppressProgressTracking],
  );

  const goToHrefSafely = useCallback(
    (href: string) => {
      if (!href) return;
      suppressProgressTracking();
      bridgeRef.current?.goToHref(href);
    },
    [suppressProgressTracking],
  );

  // ── Search ─────────────────────────────────────────────────────────────────
  // Use bridgeRef for lazy access (bridge is initialized later)
  const search = useReaderSearch({
    currentCfi,
    bridge: {
      search: (q) => bridgeRef.current?.search?.(q),
      clearSearch: () => bridgeRef.current?.clearSearch?.(),
      navigateSearch: (idx) => bridgeRef.current?.navigateSearch?.(idx),
      goToCFI: (cfi) => goToCFISafely(cfi),
    },
  });

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    sessionProgressRef.current = null;
    totalBookCharactersRef.current = null;
    suppressProgressTracking(INITIAL_PROGRESS_RESTORE_GUARD_MS);
  }, [bookId]);
  const chapterTranslation = useChapterTranslation({
    bookId,
    sectionIndex: currentSectionIndex,
    aiConfig,
    ready: translationReady,
    translationConfig,
    // 与 win 一致:整章翻译属于取词翻译,强制 selectionModel(无全局兜底)
    requireModelSelection: true,
    getParagraphs: async () => {
      if (!chapterTranslationBridgeRef.current) return [];
      return chapterTranslationBridgeRef.current.getChapterParagraphs();
    },
    injectTranslations: (results, visibility) => {
      return chapterTranslationBridgeRef.current?.injectChapterTranslations(results, visibility);
    },
    removeTranslations: () => {
      chapterTranslationBridgeRef.current?.removeChapterTranslations();
    },
    applyVisibility: (originalVisible, translationVisible) => {
      const translationHidden = !translationVisible;
      const originalHidden = !originalVisible;
      const solo = !originalVisible && translationVisible;
      bridge.webViewRef.current?.injectJavaScript(`
        (function() {
          try {
            var doc = null;
            var renderer = typeof view !== 'undefined' && view && view.renderer;
            if (renderer && renderer.getContents) {
              var contents = renderer.getContents();
              if (contents && contents[0] && contents[0].doc) doc = contents[0].doc;
            }
            if (!doc) {
              var iframes = document.querySelectorAll('iframe');
              for (var fi = 0; fi < iframes.length; fi++) {
                try {
                  var iframeDoc = iframes[fi].contentDocument || (iframes[fi].contentWindow && iframes[fi].contentWindow.document);
                  if (iframeDoc && iframeDoc.body) { doc = iframeDoc; break; }
                } catch (e) {}
              }
            }
            if (!doc) return;
            var els = doc.querySelectorAll('.readany-translation');
            for (var i = 0; i < els.length; i++) {
              els[i].setAttribute('data-hidden', '${translationHidden}');
              els[i].setAttribute('data-solo', '${solo}');
            }
            var origEls = doc.querySelectorAll('[data-translate-id]');
            for (var j = 0; j < origEls.length; j++) {
              origEls[j].setAttribute('data-original-hidden', '${originalHidden}');
            }
          } catch(e) {}
        })();
        true;
      `);
    },
    getCurrentCfi: () => currentCfi,
    goToCfi: (cfi) => bridgeRef.current?.goToCFI(cfi),
  });

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  // Also read ttsPlayState from store for volume paging guard
  const ttsPlayState = useTTSStore((s) => s.playState);
  const ttsConfig = useTTSStore((s) => s.config);

  // Focus & foreground state for volume paging whitelist
  const isFocused = useIsFocused();
  const [appActive, setAppActive] = useState(true);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s: AppStateStatus) =>
      setAppActive(s === "active"),
    );
    return () => sub.remove();
  }, []);

  // Load reader HTML asset (共享预下载:App 启动时已后台下载,这里秒取)
  useEffect(() => {
    if (assetLoadedRef.current) return;
    assetLoadedRef.current = true;

    const loadAsset = async () => {
      try {
        const uri = await getReaderHtmlUri();
        if (uri) {
          setReaderHtmlUri(uri);
        } else {
          throw new Error("reader.html localUri unavailable");
        }
      } catch (err) {
        console.error("[ReaderScreen] Failed to load reader.html asset:", err);
        setError("Failed to load reader");
      }
    };
    if (!readerHtmlUri) loadAsset();
  }, [readerHtmlUri]);

  // Controls toggle — declared before bridge so onTap can reference it without TS error
  const toggleControls = useCallback(() => {
    const willShow = !showControls;
    // 控制栏显示/隐藏都会触发 foliate 重排(吞掉进行中的触摸序列,
    // touchend/touchcancel 不派发 → selectTimer 残留 → 400ms 后误弹词)。
    // 无条件主动取消长按手势。
    try {
      bridge.webViewRef.current?.injectJavaScript(
        `handleCommand(${JSON.stringify({ type: "clearWordLookupGesture" })}); true;`,
      );
    } catch (e) { /* bridge 尚未就绪 */ }
    setShowControls(willShow);
    // 系统栏(状态栏+三键)与控制栏动画同步起跑:先于动画调用一次原生 hide/show(systemBars),
    // 两栏合入同一个系统 insets 动画,避免"工具栏先消失、三键几十 ms 后消失"的二段式
    readerSystemBarsRef.current?.setEnabled?.(willShow);
    Animated.timing(toolbarAnim, {
      toValue: willShow ? 0 : TOOLBAR_HIDE_OFFSET,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    if (willShow) {
      if (controlsTimer.current) clearTimeout(controlsTimer.current);
      controlsTimer.current = setTimeout(() => {
        setShowControls(false);
        Animated.timing(toolbarAnim, {
          toValue: TOOLBAR_HIDE_OFFSET,
          duration: 180,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start();
      }, CONTROLS_TIMEOUT);
    }
  }, [showControls, toolbarAnim]);

  // Reader bridge
  const bridge = useReaderBridge({
    onReady: () => {
      setWebViewReady(true);
      webViewReadyRef.current = true;
      bridge.webViewRef.current?.injectJavaScript(`
        (function() {
          if (!window.__view && document.querySelector('foliate-view')) {
            window.__view = document.querySelector('foliate-view');
          }
        })();
        true;
      `);
    },
    onLoaded: () => {
      setLoading(false);
      const settings = useSettingsStore.getState().readSettings;
      const { fonts, selectedFontId: selId } = useFontStore.getState();
      const fontCSS = buildCustomFontFaceCSS(fonts, selId, fileServerRef.current);
      const fontFamily = selId ? fonts.find((f) => f.id === selId)?.fontFamily : "";
      console.log("[ReaderScreen][Font] selection", {
        selectedFontId: selId,
        fontFamily,
        fontCSSLength: fontCSS.length,
      });
      bridge.applySettings({
        fontSize: computeEffectiveFontSize(settings.fontSize, settings.followSystemFontScale),
        lineHeight: settings.lineHeight,
        paragraphSpacing: settings.paragraphSpacing,
        pageMargin: settings.pageMargin,
        fontTheme: settings.fontTheme,
        useBookFonts: settings.useBookFonts,
        viewMode: settings.viewMode,
        paginatedLayout: settings.paginatedLayout,
        sideTapPageTurn: settings.sideTapPageTurn !== false,
        longPressLookupMode: settings.longPressLookupMode ?? "auto",
        customFontFaceCSS: fontCSS,
        customFontFamily: fontFamily ?? "",
      });

      // Auto-restore ruby annotations if enabled for this book
      const rubyMode = useRubyStore.getState().getBookRuby(bookId);
      if (rubyMode) {
        void (async () => {
          try {
            const { checkExistingDictMobile, readDictStrings } = await import(
              "@/lib/ruby/dict-service-mobile"
            );
            const exists = await checkExistingDictMobile();
            if (exists) {
              const { wordDict, charDict } = await readDictStrings();
              if (wordDict || charDict) {
                bridge.setRubyDicts(wordDict, charDict);
                setTimeout(() => bridge.injectRuby(rubyMode), 150);
              }
            }
          } catch (err) {
            console.error("[ReaderScreen] Ruby auto-restore failed:", err);
          }
        })();
      }
    },
    onBookTextMetrics: ({ totalCharacters }) => {
      totalBookCharactersRef.current = totalCharacters > 0 ? totalCharacters : null;
    },
    onRelocate: (detail: RelocateEvent) => {
      console.log("[ReaderScreen] onRelocate", {
        section: detail.section,
        fraction: detail.fraction,
        cfi: detail.cfi,
        routeCfi: cfi,
        lastNavigated: lastNavigatedCfiRef.current,
      });
      if (loading) {
        setLoading(false);
      }
      // Track section changes for chapter translation reset
      const newSection = detail.section?.current ?? 0;
      if (newSection !== currentSectionIndex) {
        setCurrentSectionIndex(newSection);
        setTranslationReady(false);
        chapterTranslation.reset();
      }

      if (detail.fraction != null) setProgress(detail.fraction);

      if (detail.page) {
        setCurrentPage(Math.max(1, detail.page.current));
        setTotalPages(Math.max(1, detail.page.total));
      } else if (detail.section?.total && !detail.location?.total) {
        // Fixed-layout documents can still expose stable section pages.
        setCurrentPage(Math.max(1, detail.section.current + 1));
        setTotalPages(Math.max(1, detail.section.total));
      } else {
        // Reflowable books without renderer-backed pagination should fall back to percent.
        setCurrentPage(0);
        setTotalPages(0);
      }

      const trackingSuppressed = Date.now() < progressTrackingGuardUntilRef.current;

      if (detail.location?.total) {
        const totalBookCharacters = totalBookCharactersRef.current;
        const fraction = detail.fraction ?? 0;
        if (totalBookCharacters && totalBookCharacters > 0) {
          const currentCharacters = Math.round(totalBookCharacters * fraction);
          const previous = sessionProgressRef.current;
          const currentSection = detail.section?.current ?? 0;
          const currentRendererPage = detail.page?.current ?? null;

          if (
            !trackingSuppressed &&
            previous?.mode === "characters" &&
            currentCharacters > previous.current
          ) {
            if (currentRendererPage != null && previous.page != null && previous.section != null) {
              const samePage =
                previous.section === currentSection && previous.page === currentRendererPage;
              const movedForwardWithinSection =
                previous.section === currentSection &&
                currentRendererPage > previous.page &&
                currentRendererPage - previous.page <= MAX_TRACKED_PAGE_DELTA;
              const movedForwardAcrossSection =
                currentSection > previous.section && currentSection - previous.section <= 1;

              if (!samePage && (movedForwardWithinSection || movedForwardAcrossSection)) {
                incrementCharactersRead(currentCharacters - previous.current);
              }
            } else if (
              Math.abs(fraction - (previous.fraction ?? 0)) <= MAX_TRACKED_FRACTION_DELTA
            ) {
              incrementCharactersRead(currentCharacters - previous.current);
            }
          }
          sessionProgressRef.current = {
            mode: "characters",
            current: currentCharacters,
            fraction,
            section: currentSection,
            page: currentRendererPage ?? undefined,
          };
        } else {
          const previous = sessionProgressRef.current;
          if (
            !trackingSuppressed &&
            previous?.mode === "location" &&
            detail.location.current > previous.current
          ) {
            const delta = detail.location.current - previous.current;
            if (delta <= MAX_TRACKED_LOCATION_DELTA) {
              incrementCharactersRead(delta * REFLOWABLE_CHARACTERS_PER_LOCATION);
            }
          }
          sessionProgressRef.current = {
            mode: "location",
            current: detail.location.current,
            fraction,
          };
        }
      } else if (detail.section?.total) {
        const previous = sessionProgressRef.current;
        if (
          !trackingSuppressed &&
          previous?.mode === "page" &&
          detail.section.current > previous.current
        ) {
          const delta = detail.section.current - previous.current;
          if (delta <= MAX_TRACKED_PAGE_DELTA) {
            incrementPagesRead(delta);
          }
        }
        sessionProgressRef.current = { mode: "page", current: detail.section.current };
      }
      if (detail.tocItem?.label) setCurrentChapter(detail.tocItem.label);
      if (detail.cfi) {
        if (lastCfiRef.current && detail.cfi !== lastCfiRef.current) {
          const fractionDiff = Math.abs((detail.fraction ?? 0) - progress);
          if (fractionDiff > 0.02 || locationHistoryRef.current.length === 0) {
            locationHistoryRef.current.push(lastCfiRef.current);
            if (locationHistoryRef.current.length > 50) {
              locationHistoryRef.current.shift();
            }
          }
        }
        lastCfiRef.current = detail.cfi;
        setCurrentCfi(detail.cfi);
        // Use throttled save instead of immediate update
        throttledSaveProgress(bookId, detail.fraction ?? 0, detail.cfi);
      }

      // Mark translation ready after first successful relocate (CFI navigation done)
      if (!translationReady) setTranslationReady(true);

      // If TTS is waiting for a page turn to complete, fire the continuation callback now
      // that the renderer has fully updated its position (renderer.start reflects new page).
      if (ttsPendingContinueRef.current?.pendingTTSContinueCallbackRef.current) {
        console.log("[ReaderScreen][TTS] onRelocate triggered pending TTS continuation");
        const cb = ttsPendingContinueRef.current.pendingTTSContinueCallbackRef.current;
        ttsPendingContinueRef.current.pendingTTSContinueCallbackRef.current = null;
        // Cancel the safety timer since onRelocate fired successfully
        const safetyTimerRef = ttsPendingContinueRef.current.pendingTTSContinueSafetyTimerRef;
        if (safetyTimerRef.current) {
          clearTimeout(safetyTimerRef.current);
          safetyTimerRef.current = null;
        }
        void cb();
      }

      // Sync reading context for AI tools
      const tocIndex = detail.section?.current ?? 0;
      const tocTitle =
        detail.tocItem?.label ||
        toc.find((item) => item.index === tocIndex)?.title ||
        "";
      readingContextService.updateContext({
        bookId,
        bookTitle: book?.meta?.title || "",
        currentChapter: {
          index: tocIndex,
          title: tocTitle,
          href: detail.tocItem?.href || "",
        },
        currentPosition: {
          cfi: detail.cfi || "",
          percentage: (detail.fraction ?? 0) * 100,
        },
      });
    },
    onTocReady: (items: TOCItem[]) => {
      setToc(items);
      // Feed TOC to the reading context so AI tools can resolve chapter titles
      // even when relocate events don't carry a tocItem label.
      const flatToc: Array<{ index: number; title: string; href?: string }> = [];
      const walk = (list: TOCItem[]) => {
        for (const item of list) {
          flatToc.push({
            index: item.index ?? flatToc.length,
            title: item.title,
            ...(item.href ? { href: item.href } : {}),
          });
          if (item.subitems?.length) walk(item.subitems);
        }
      };
      walk(items);
      readingContextService.updateContext({ toc: flatToc as never });
    },
    onSelection: (detail: SelectionEvent) => {
      setSelection(detail);
      // Sync selection for AI tools
      if (detail.cfi) {
        readingContextService.updateSelection({
          text: detail.text,
          cfi: detail.cfi,
          chapterIndex: 0,
          chapterTitle: "",
        });
      }
    },
    onSelectionCleared: () => {
      setSelection(null);
      readingContextService.clearSelection();
    },
    onWordLookup: (detail) => {
      // 静读天下双定时器机制:长按 400ms 选词 + 400ms 后(共 800ms)读当前选区弹词。
      // JS 侧 gesture 门控已保证手势期不推 'selection',此调用多为 no-op,保留作纵深防御。
      setSelection(null);
      suppressReaderTapUntilRef.current = Date.now() + 900;
      // 按翻译引擎分流:外部翻译→词典接口表;内置翻译(ai/deepl/microsoft)→内置查词弹窗
      handleWordLookup(detail.word);
    },
    onTap: () => {
      if (noteTooltipVisibleRef.current || Date.now() < suppressReaderTapUntilRef.current) {
        return;
      }
      sendEvent({ type: "activity" });
      if (selection) {
        setSelection(null);
        return;
      }
      toggleControls();
    },
    onToggleBookmark: () => {
      handleToggleBookmark();
    },
    onBookmarkPull: ({ offset, active }) => {
      if (active) {
        readerPullAnim.setValue(offset);
        return;
      }

      Animated.timing(readerPullAnim, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }).start();
    },
    onSearchResult: (index: number, count: number) => {
      search.onSearchResult(index, count);
    },
    onSearchComplete: (count: number) => {
      search.onSearchComplete(count);
    },
    onError: (message: string) => {
      console.error("[Reader] WebView error:", message);
      if (loading) {
        setError(message);
        setLoading(false);
      }
    },
    onShowAnnotation: (detail: {
      value: string;
      position: { x: number; y: number; selectionTop: number; selectionBottom: number };
    }) => {
      suppressReaderTapUntilRef.current = Date.now() + 650;
      const highlight = highlights.find((h) => h.cfi === detail.value);
      if (!highlight) return;
      setSelection({
        text: highlight.text,
        cfi: highlight.cfi,
        position: detail.position,
      });
    },
    onNoteTooltip: (detail) => {
      suppressReaderTapUntilRef.current = Date.now() + 900;
      // Dismiss any existing tooltip
      if (noteTooltipTimer.current) {
        clearTimeout(noteTooltipTimer.current);
      }
      setNoteTooltip({
        note: detail.note,
        cfi: detail.cfi,
        position: detail.position,
      });
      // Auto-hide after 4 seconds
      noteTooltipTimer.current = setTimeout(() => {
        setNoteTooltip(null);
        noteTooltipTimer.current = null;
      }, 4000);
    },
    onPageSnippet: (_text: string) => {
      // page snippet handled by bookmark hook if pending
    },
    onBookmarkSnippet: (text: string) => {
      bookmark.onBookmarkSnippet(text);
    },
  });

  useEffect(() => {
    noteTooltipVisibleRef.current = !!noteTooltip;
  }, [noteTooltip]);

  // ── Volume button paging ─────────────────────────────────────────────────
  const isPureReadingContext = useMemo(
    () =>
      Platform.OS === "android" &&
      readSettings.volumeButtonsPageTurn === true &&
      webViewReady &&
      !loading &&
      !error &&
      !isReimporting &&
      !showSearch &&
      !showTOC &&
      !showSettings &&
      !showNotebook &&
      !showTTS &&
      !showTranslation &&
      !showChapterTranslation &&
      chapterTranslation.state.status === "idle" &&
      !noteViewHighlight &&
      !noteTooltip &&
      ttsPlayState === "stopped" &&
      isFocused &&
      appActive,
    // 维护约定：任何新增遮盖正文/输入态/导航跳转，必须在此追加判定。
    [
      readSettings.volumeButtonsPageTurn, webViewReady, loading, error, isReimporting,
      showSearch, showTOC, showSettings, showNotebook, showTTS,
      showTranslation, showChapterTranslation, chapterTranslation.state.status,
      selection, noteViewHighlight, noteTooltip, ttsPlayState, isFocused, appActive,
    ],
  );

  useVolumeButtonPaging({
    active: isPureReadingContext,
    onPrev: () => bridge.goPrev(),
    onNext: () => bridge.goNext(),
  });

  bridgeRef.current = bridge;
  chapterTranslationBridgeRef.current = bridge;

  // 自愈:WebView 在转场动画期间创建时,Android 可能跳过 JS 初始化(ready 永不发,
  // 一直转圈)。8s 未 ready 则重建 WebView(此时页面已稳定,加载必成功)。
  // 重建最多 2 次,避免死循环。
  useEffect(() => {
    if (webViewReady || !readerHtmlUri) return;
    const t = setTimeout(() => {
      if (!webViewReadyRef.current && webViewEpoch < 2) {
        console.warn("[ReaderScreen] WebView not ready, recreating...");
        webViewReadyRef.current = false;
        setWebViewReady(false);
        setWebViewEpoch((e) => e + 1);
      }
    }, 8000);
    return () => clearTimeout(t);
  }, [webViewReady, readerHtmlUri, webViewEpoch]);

  // ── useReaderTTS ──
  const tts = useReaderTTS({
    bookId,
    bookTitle: bookTitle || book?.meta.title || "",
    currentChapter,
    currentSectionIndex,
    currentCfi,
    webViewReady,
    showTTS,
    setShowTTS,
    setShowControls,
    bridgeRef,
    toc,
    bookCoverUrl: book?.meta.coverUrl,
    colors,
    goToHref: bridge.goToHref,
  });

  // Bind mediator ref so onRelocate can fire the TTS continuation callback
  ttsPendingContinueRef.current = {
    pendingTTSContinueCallbackRef: tts.pendingTTSContinueCallbackRef,
    pendingTTSContinueSafetyTimerRef: tts.pendingTTSContinueSafetyTimerRef,
  };

  // ── Non-TTS callbacks ──────────────────────────────────────────────────────

  const goToTocItem = useCallback(
    (href: string) => {
      if (lastCfiRef.current) {
        locationHistoryRef.current.push(lastCfiRef.current);
      }
      goToHrefSafely(href);
      setShowTOC(false);
    },
    [goToHrefSafely],
  );

  const goBackToPreviousLocation = useCallback(() => {
    if (locationHistoryRef.current.length === 0) return;
    const previousCfi = locationHistoryRef.current.pop();
    if (previousCfi) {
      goToCFISafely(previousCfi);
    }
  }, [goToCFISafely]);

  const canGoBack = locationHistoryRef.current.length > 0;

  const updateSetting = useCallback(
    <K extends keyof ReadSettings>(key: K, value: ReadSettings[K]) => {
      const updates = { [key]: value } as Partial<ReadSettings>;
      updateReadSettings(updates);
      const currentSettings = useSettingsStore.getState().readSettings;
      const { fonts, selectedFontId: selId } = useFontStore.getState();
      const fontCSS = buildCustomFontFaceCSS(fonts, selId, fileServerRef.current);
      const fontFamily = selId ? fonts.find((f) => f.id === selId)?.fontFamily : "";
      // Recompute effective fontSize after every settings change — covers
      // both stepper changes and toggling followSystemFontScale on/off.
      const merged = { ...currentSettings, ...updates };
      bridge.applySettings({
        ...merged,
        fontSize: computeEffectiveFontSize(merged.fontSize, merged.followSystemFontScale),
        customFontFaceCSS: fontCSS,
        customFontFamily: fontFamily ?? "",
      });
    },
    [bridge, updateReadSettings, computeEffectiveFontSize],
  );

  const handleDismissSelection = useCallback(() => {
    setSelection(null);
  }, []);

  // ── 长按查词分流:外部翻译→词典接口表;内置翻译→内置查词弹窗 ──────────────────
  // 状态(内置查词弹窗;外部翻译拉起第三方词典,不走这里)
  const [lookupWord, setLookupWord] = useState<string | null>(null);
  const [lookupPending, setLookupPending] = useState(false);
  const [lookupResult, setLookupResult] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const lookupSeqRef = useRef(0);

  const lookupExternal = useCallback(
    (word: string) => {
      launchDictionary(
        word,
        translationConfig.dictionaryOptionKey,
        translationConfig.dictionaryCustomUrl,
      ).catch((err) => {
        if (err instanceof DictionaryNotInstalledError) {
          Alert.alert(
            t("settings.dictionaryNotInstalledTitle", "未安装所选词典"),
            t(err.labelKey, err.labelKey),
          );
        } else if (err instanceof DictionaryOptionNotConfiguredError) {
          Alert.alert(
            t("settings.dictionaryOptionCustomNotSet", "自定义在线词典未配置"),
            t("settings.dictionaryOptionCustomHint", "请在翻译设置中填写自定义 URL"),
          );
        } else {
          Alert.alert(
            t("settings.dictionaryLookupFailed", "查词失败"),
            err instanceof Error ? err.message : String(err),
          );
        }
      });
    },
    [translationConfig.dictionaryOptionKey, translationConfig.dictionaryCustomUrl, t],
  );

  /** 内置翻译请求(查词=dictionary / 取词=selection),弹窗共用一个结果状态 */
  const runBuiltinLookup = useCallback(
    (text: string, mode: BuiltinLookupMode) => {
      const seq = ++lookupSeqRef.current;
      setLookupWord(text);
      setLookupPending(true);
      setLookupResult(null);
      setLookupError(null);
      translateBuiltin(text, translationConfig, aiConfig, mode)
        .then((result) => {
          if (seq !== lookupSeqRef.current) return; // 已被更新的请求覆盖
          setLookupResult(result ? result.trim() : "");
        })
        .catch((err) => {
          if (seq !== lookupSeqRef.current) return;
          // resolveTranslationModel 缺配置时抛中文指引(TRANSLATION_MODEL_UNSET_MESSAGE),原样展示
          setLookupError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (seq === lookupSeqRef.current) setLookupPending(false);
        });
    },
    [translationConfig, aiConfig],
  );

  const handleWordLookup = useCallback(
    (word: string) => {
      if (translationConfig.provider.id === "external") {
        lookupExternal(word);
      } else {
        runBuiltinLookup(word, "dictionary");
      }
    },
    [translationConfig.provider.id, lookupExternal, runBuiltinLookup],
  );

  /** 划词翻译:外部翻译→词典接口;内置翻译→标准翻译(默认提示词,不用自定义词典提示词) */
  const handleTranslateSelection = useCallback(
    (text: string) => {
      if (translationConfig.provider.id === "external") {
        lookupExternal(text);
      } else {
        runBuiltinLookup(text, "selection");
      }
    },
    [translationConfig.provider.id, lookupExternal, runBuiltinLookup],
  );


  const closeLookup = useCallback(() => {
    lookupSeqRef.current++;
    setLookupWord(null);
    setLookupPending(false);
    setLookupResult(null);
    setLookupError(null);
  }, []);

  useEffect(() => {
    setGoToCfiFn(() => bridge.goToCFI);
    return () => setGoToCfiFn(null);
  }, [bridge.goToCFI, setGoToCfiFn]);

  // ── Book loading effects ───────────────────────────────────────────────────

  // Load book metadata and annotations
  useEffect(() => {
    if (!book) {
      setError(t("reader.bookNotFound", "书籍未找到"));
      setLoading(false);
      return;
    }
    // book 从"无料"变"有"(书库异步加载完成/或 DB 兜底到达),清除"未找到"错误
    setError(null);
    setBookTitle(book.meta.title);
    updateBook(bookId, { lastOpenedAt: Date.now() });
    loadAnnotations(bookId);

    return () => {
      readingContextService.clearContext();
    };
    // 依赖 Boolean(book):只在"无→有/有→无"边界重跑。直接依赖 book 会因
    // updateBook 更新 books 数组形成循环(新引用→重跑→再写)
  }, [bookId, Boolean(book)]);

  useEffect(() => {
    return eventBus.on("sync:completed", () => {
      void loadAnnotations(bookId);
    });
  }, [bookId, loadAnnotations]);

  // Save progress immediately on unmount
  useEffect(() => {
    return () => {
      // 文件服务器不随 Reader 卸载停止:Lighttpd 冷启动约 700ms,每次进出
      // 阅读页都重启会慢;服务器常驻进程生命周期(docRoot=appData 恒定,
      // 所有书共享),reload 残留由 local-file-server 的防御逻辑处理
      if (lastCfiRef.current) {
        const db = require("@readany/core/db/database");
        runWithDbRetry(
          () =>
            db.updateBook(bookId, {
              progress: progressRef.current,
              currentCfi: lastCfiRef.current,
            }),
          { attempts: 10, initialDelayMs: 150 },
        ).catch((err: Error) => console.error("Failed to save progress on unmount:", err));
        void saveReadingProgressForBook(bookId, {
          cfi: lastCfiRef.current,
          percent: progressRef.current,
        }).catch((err: Error) => console.error("Failed to save reading progress on unmount:", err));
      }
      const { useSyncStore } = require("@readany/core/stores/sync-store");
      useSyncStore.getState().syncNow?.();
    };
  }, [bookId]);

  // When WebView is ready and book is available, send the open command
  useEffect(() => {
    if (!webViewReady || !book?.filePath) {
      return;
    }

    const loadBook = async () => {
      try {
        setLoading(true);
        setError(null);
        const platform = getPlatformService();
        const appData = await platform.getAppDataDir();
        const absPath = await platform.joinPath(appData, book.filePath);
        // 本设备 current_cfi 优先(更鲜);为空时兜底取跨设备进度(按 book hash)
        let lastLocation = book.currentCfi || undefined;
        if (!lastLocation) {
          try {
            lastLocation = (await getReadingProgressForBook(book.fileHash))?.cfi || undefined;
          } catch (err) {
            console.error("Failed to read reading progress:", err);
          }
        }
        const fileName = book.filePath.split("/").pop() || "book.epub";
        const mimeType = BOOK_FORMAT_MIME_TYPES[book.format] || "application/octet-stream";

        // Start a local HTTP server so the WebView can fetch the file directly.
        // This avoids loading the entire file into RN memory + base64 encoding (33% overhead)
        // and the massive JSON serialization through injectJavaScript.
        const serverUrl = await startFileServer(appData);
        fileServerRef.current = serverUrl;
        setFontServerUrl(serverUrl);
        const encodedPath = book.filePath
          .split("/")
          .map((s) => encodeURIComponent(s))
          .join("/");

        bridge.openBook({
          uri: `${serverUrl}/${encodedPath}`,
          fileName,
          mimeType,
          lastLocation,
          pageMargin: readSettings.pageMargin,
          paginatedLayout: readSettings.paginatedLayout,
          settings: {
            fontSize: readSettings.fontSize,
            lineHeight: readSettings.lineHeight,
            paragraphSpacing: readSettings.paragraphSpacing,
            pageMargin: readSettings.pageMargin,
            fontTheme: readSettings.fontTheme,
            useBookFonts: readSettings.useBookFonts,
            viewMode: readSettings.viewMode,
            paginatedLayout: readSettings.paginatedLayout,
          },
        });

        bridge.setThemeColors({
          background: colors.background,
          foreground: colors.foreground,
          muted: colors.mutedForeground,
          primary: colors.primary,
          themeMode,
        });
      } catch (err: any) {
        console.error("[ReaderScreen] Failed to load book:", err);
        setError(err.message || "Failed to load book file");
        setLoading(false);
      }
    };

    loadBook();
  }, [bookId, book?.filePath, loadAttempt, webViewReady]);

  const handleReimportMissingBook = useCallback(async () => {
    if (isReimporting) return;
    setIsReimporting(true);

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: BOOK_MIME_TYPES,
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      const selectedUri = result.assets[0].uri;
      if (book) {
        const candidate = await useLibraryStore.getState().inspectDeletedBookCandidate(bookId, {
          uri: selectedUri,
          name: result.assets[0].name,
        });
        if (candidate && shouldConfirmReimportCandidate(book, candidate)) {
          const shouldContinue = await useMissingBookPromptStore.getState().showPrompt({
            title: t("reader.reimportMismatchTitle", "这份文件看起来和原书不太一致"),
            description: t(
              "reader.reimportMismatchDescription",
              "原书《{{originalTitle}}》与当前文件《{{candidateTitle}}》信息差异较大。仍要把它接回原来的笔记和阅读统计吗？",
              {
                originalTitle: book.meta.title,
                candidateTitle: candidate.title || t("reader.unknownBook", "未命名书籍"),
              },
            ),
            confirmLabel: t("reader.reimportContinue", "继续接回"),
            cancelLabel: t("reader.reimportPickAnotherFile", "重新选择"),
          });
          if (!shouldContinue) return;
        }
      }

      const restoredBook = await useLibraryStore
        .getState()
        .reimportDeletedBook(bookId, { uri: selectedUri, name: result.assets[0].name });

      if (!restoredBook) {
        setError(t("reader.reimportFailed", "重新导入失败，请稍后再试。"));
        return;
      }

      setError(null);
      setLoading(true);
    } catch (err) {
      console.error("[ReaderScreen] Failed to re-import missing book:", err);
      setError(
        err instanceof Error
          ? err.message
          : t("reader.reimportFailed", "重新导入失败，请稍后再试。"),
      );
    } finally {
      setIsReimporting(false);
    }
  }, [bookId, isReimporting, t]);

  // Apply theme colors when theme changes
  useEffect(() => {
    if (!webViewReady) return;
    bridge.setThemeColors({
      background: colors.background,
      foreground: colors.foreground,
      muted: colors.mutedForeground,
      primary: colors.primary,
      themeMode,
    });
  }, [themeMode, webViewReady]);

  // 沉浸式全屏:进入阅读隐藏系统三键导航栏;控制栏/搜索显示时恢复
  // 三键恒藏由上方 SystemBars(navigationBar: true)统一管理,不再在此随面板显隐

  // 退出阅读器恢复导航栏
  useEffect(() => {
    return () => {
      NavigationBar.setVisibilityAsync("visible").catch(() => {});
      NavigationBar.setBehaviorAsync("inset-swipe").catch(() => {});
    };
  }, []);

  // Re-apply font settings when custom fonts or selected font changes
  useEffect(() => {
    if (!webViewReady) return;
    bridge.applySettings({
      customFontFaceCSS: customFontFaceCSS,
      customFontFamily: customFontFamily,
    });
  }, [customFontFaceCSS, customFontFamily, webViewReady]);

  // Re-apply effective fontSize when the OS-level font scale changes while
  // the reader is open (e.g. user changes "Display & Brightness → Text Size"
  // in iOS Settings, then comes back). Only fires when followSystemFontScale
  // is on; otherwise the stored fontSize is used as-is and there's nothing
  // to re-push.
  //
  // We also re-send paragraphSpacing and pageMargin so the webview's
  // layoutScale-based scaling (in reader.template.html) re-runs against the
  // new effective font size — otherwise the renderer would keep margins
  // computed from the previous size.
  useEffect(() => {
    if (!webViewReady) return;
    if (!readSettings.followSystemFontScale) return;
    bridge.applySettings({
      fontSize: computeEffectiveFontSize(readSettings.fontSize, true),
      paragraphSpacing: readSettings.paragraphSpacing,
      pageMargin: readSettings.pageMargin,
    });
  }, [
    systemFontScale,
    readSettings.followSystemFontScale,
    readSettings.fontSize,
    readSettings.paragraphSpacing,
    readSettings.pageMargin,
    webViewReady,
    bridge,
    computeEffectiveFontSize,
  ]);

  // Load annotations into reader when ready
  useEffect(() => {
    if (!webViewReady || loading || highlights.length === 0) return;
    for (const h of highlights) {
      bridge.addAnnotation({ value: h.cfi, type: "highlight", color: h.color, note: h.note });
    }
  }, [webViewReady, loading, highlights]);

  // Reset last navigated CFI when book changes
  useEffect(() => {
    lastNavigatedCfiRef.current = undefined;
  }, [bookId]);

  // Navigate to CFI when book is loaded (from NotesPage or AI citation navigation)
  useEffect(() => {
    if (!webViewReady || loading || !cfi || cfi === lastNavigatedCfiRef.current) return;
    goToCFISafely(cfi);
    lastNavigatedCfiRef.current = cfi;
    navigation.setParams({ bookId, cfi: undefined, highlight: undefined });

    if (shouldHighlight) {
      let flashCount = 0;
      const doFlash = () => {
        if (flashCount >= 3) return;
        bridge.flashHighlight(cfi, "darkblue", 500);
        flashCount++;
        if (flashCount < 3) setTimeout(doFlash, 600);
      };
      setTimeout(doFlash, 100);
    }
  }, [webViewReady, loading, cfi, shouldHighlight, goToCFISafely, navigation, bookId]);

  // Open TTS lyrics page when navigating from notification
  useEffect(() => {
    if (!openTTS || !webViewReady || loading) return;

    let cancelled = false;
    const openLyricsPage = async () => {
      const targetCfi =
        tts.resolvedTTSSegmentCfi || tts.ttsDisplaySegments[0]?.cfi || currentCfi || null;
      if (targetCfi && targetCfi !== currentCfi) {
        goToCFISafely(targetCfi);
        await new Promise((resolve) => setTimeout(resolve, 320));
      }
      if (cancelled) return;
      setShowControls(false);
      setShowTTS(true);
      navigation.setParams({ bookId, openTTS: undefined });
    };

    void openLyricsPage();
    return () => {
      cancelled = true;
    };
  }, [bookId, currentCfi, goToCFISafely, loading, navigation, openTTS, webViewReady]);

  if (loading && !webViewReady && !readerHtmlUri) {
    return (
      <SafeAreaView style={[s.container, { backgroundColor: colors.background }]}>
        <View style={s.loadingWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={s.loadingText}>{t("reader.loading", "正在加载...")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={[s.container, { backgroundColor: colors.background }]}>
        <View style={s.loadingWrap}>
          <Text style={s.errorText}>{t("reader.loadFailed", "加载失败")}</Text>
          <Text style={[s.loadingText, { textAlign: "center", maxWidth: 320 }]}>{error}</Text>
          <View style={{ flexDirection: "row", gap: 12, marginTop: 8 }}>
            <TouchableOpacity
              style={s.backButton}
              onPress={() => {
                if (book?.filePath) {
                  setLoading(true);
                  setError(null);
                  setLoadAttempt((value) => value + 1);
                  return;
                }
                navigation.reset({ routes: [{ name: "Tabs" }] });
              }}
            >
              <Text style={s.backButtonText}>
                {book?.filePath ? t("common.retry", "重试") : t("common.back", "返回")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                s.backButton,
                { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
              ]}
              onPress={() => void handleReimportMissingBook()}
              disabled={isReimporting}
            >
              <Text style={[s.backButtonText, { color: colors.foreground }]}>
                {isReimporting
                  ? t("reader.reimporting", "正在重新导入...")
                  : t("reader.reimport", "重新导入")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!readerHtmlUri) {
    return (
      <View style={s.container}>
        <View style={s.loadingWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={s.loadingText}>{t("reader.loading", "加载阅读器...")}</Text>
        </View>
      </View>
    );
  }

  const layoutTopInset = stableTopInset;
  const topToolbarRowHeight = isWideLayout ? 62 : 48;
  const bottomDockIconSize = isWideLayout ? 24 : 22;
  const topToolbarIconSize = isWideLayout ? 24 : 22;
  const percent = Math.round(progress * 100);
  const topControlsTranslate = toolbarAnim.interpolate({
    inputRange: [0, TOOLBAR_HIDE_OFFSET],
    outputRange: [0, -10],
  });
  const topControlsOpacity = toolbarAnim.interpolate({
    inputRange: [0, TOOLBAR_HIDE_OFFSET * 0.5, TOOLBAR_HIDE_OFFSET],
    outputRange: [1, 0.28, 0],
  });
  const bottomControlsTranslate = toolbarAnim.interpolate({
    inputRange: [0, TOOLBAR_HIDE_OFFSET],
    outputRange: [0, 12],
  });
  const bottomControlsOpacity = toolbarAnim.interpolate({
    inputRange: [0, TOOLBAR_HIDE_OFFSET * 0.5, TOOLBAR_HIDE_OFFSET],
    outputRange: [1, 0.28, 0],
  });
  const auxToolsTranslate = toolbarAnim.interpolate({
    inputRange: [0, TOOLBAR_HIDE_OFFSET],
    outputRange: [0, 14],
  });
  const auxToolsOpacity = toolbarAnim.interpolate({
    inputRange: [0, TOOLBAR_HIDE_OFFSET * 0.55, TOOLBAR_HIDE_OFFSET],
    outputRange: [1, 0.24, 0],
  });

  const isPanelOpen = showTOC || showSettings || showSearch || showNotebook || showTranslation;
  // 顶部 margin 固定基线(状态栏显隐不变):面板打开状态栏出现时若跟着 insets.top 变,
  // webview 高度会收缩 → foliate 重排(老问题"页面被压缩一下")。固定后:
  // 面板打开时状态栏/工具栏以 overlay 覆盖内容顶部,webview 恒定不重排。
  const readerTopMargin = !showSearch
    ? showTopTitleProgress
      ? baseTopInset + 30
      : baseTopInset
    : 0;
  // WebView 渲染高度固定 = 窗口高 - 顶部 margin,不随系统三键显隐变化:
  // 尺寸恒定 → foliate 不重排 → 无抖动。文字延伸到底部,三键/信息条都是
  // overlay 浮在内容上(edge-to-edge 常态),不留无文字空白区
  // 基准高度用屏幕物理全尺寸(screenH),不用 useWindowDimensions:
  // vivo 上沉浸模式切换后 window 尺寸不更新,winH 会停在"全屏减系统栏"的旧值,
  // 导致底部留白;screenH 是屏幕物理高(竖屏锁定,恒定),始终覆盖到屏幕底
  const readerWebViewHeight = Math.max(screenHeight - readerTopMargin, 200);
  const batteryLabel = batteryLevel == null ? "--%" : `${Math.round(batteryLevel * 100)}%`;
  const selectionPopoverSelection = selection
    ? {
        ...selection,
        position: {
          ...selection.position,
          y: selection.position.y + readerTopMargin,
          selectionTop: selection.position.selectionTop + readerTopMargin,
          selectionBottom: selection.position.selectionBottom + readerTopMargin,
        },
      }
    : null;
  const adjustedNoteTooltip = noteTooltip
    ? {
        ...noteTooltip,
        position: {
          ...noteTooltip.position,
          y: noteTooltip.position.y + readerTopMargin,
          selectionTop: noteTooltip.position.selectionTop + readerTopMargin,
          selectionBottom: noteTooltip.position.selectionBottom + readerTopMargin,
        },
      }
    : null;

  return (
    <View style={s.container}>
      <Animated.View
        style={[s.readerStage, { transform: [{ translateY: readerPullAnim }] }]}
        pointerEvents="box-none"
      >
        {/* WebView with foliate-js */}
        <View style={{ flex: 1 }}>
          <WebView
            key={`reader-wv-${webViewEpoch}`}
            ref={bridge.webViewRef}
            source={{ uri: readerHtmlUri }}
            style={[
              s.webview,
              {
                flex: 0,
                height: readerWebViewHeight,
                marginTop: readerTopMargin,
              },
            ]}
            pointerEvents={isPanelOpen ? "none" : "auto"}
            onMessage={bridge.handleMessage}
            onError={(e) => {
              console.error("[ReaderScreen] WebView error:", e.nativeEvent);
            }}
            onHttpError={(e) => {
              console.error("[ReaderScreen] WebView HTTP error:", e.nativeEvent);
            }}
            onContentProcessDidTerminate={() => {
              console.warn("[ReaderScreen] WebView content process terminated");
            }}
            javaScriptEnabled
            domStorageEnabled
            cacheEnabled={false}
            allowFileAccess
            allowFileAccessFromFileURLs
            allowUniversalAccessFromFileURLs
            allowsInlineMediaPlayback
            scrollEnabled={false}
            showsVerticalScrollIndicator={false}
            originWhitelist={["*"]}
            mixedContentMode="always"
            onTouchEnd={() => {
              // 物理松手信号 → webview(RN 触摸层与选区句柄独立,松手必然可达)
              bridge.webViewRef.current?.injectJavaScript(
                "window.__readanyOnRelease && window.__readanyOnRelease(); true;",
              );
            }}
          />
        </View>

        {/* Loading overlay */}
        {loading && (
          <View style={s.loadingOverlay}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        )}

        {/* ─── Top Info Bar(顶栏:当前版本暂只显示书名;页数/进度已移到底部信息条) ─── */}
        {chromeReady && !showSearch && !showControls && showTopTitleProgress && (
          <View style={[s.topInfoBar, { top: layoutTopInset }]}>
            <View style={s.topInfoRow}>
              <Text style={s.topInfoText} numberOfLines={1}>
                {bookTitle}
              </Text>
            </View>
          </View>
        )}
      </Animated.View>

      {/* ─── Bookmark Ribbon (top-right) ─── */}
      {chromeReady && <BookmarkRibbon visible={isBookmarked} topOffset={0} />}

      {chromeReady && !showSearch && (
        <Animated.View
          pointerEvents={showControls ? "auto" : "none"}
          style={[
            s.topToolbar,
            {
              top: 0,
              left: 0,
              right: 0,
              opacity: topControlsOpacity,
              transform: [{ translateY: topControlsTranslate }],
            },
          ]}
        >
          <View
            style={[
              s.topToolbarBar,
              {
                // 面板打开时状态栏显示,用实时 insets.top 定位工具栏高度
                paddingTop: insets.top,
                minHeight: insets.top + topToolbarRowHeight,
              },
            ]}
          >
            <View
              style={[
                s.topToolbarRow,
                {
                  minHeight: topToolbarRowHeight,
                  paddingLeft: insets.left + 12,
                  paddingRight: insets.right + 16,
                },
              ]}
            >
              <View style={s.topToolbarSideSlot}>
                <TouchableOpacity
                  style={s.topToolbarBackBtn}
                  onPress={() => navigation.reset({ routes: [{ name: "Tabs" }] })}
                >
                  <ChevronLeftIcon size={topToolbarIconSize} color={colors.foreground} />
                </TouchableOpacity>
              </View>
              <View style={s.topToolbarTitleWrap}>
                <Text style={s.topToolbarTitleText} numberOfLines={1}>
                  {currentChapter || bookTitle}
                </Text>
              </View>
              <View
                style={[
                  s.topToolbarSideSlot,
                  s.topToolbarMetaWrap,
                  { flexDirection: "row", alignItems: "center", gap: 6 },
                ]}
              >
                <SyncButton size={16} color={colors.foreground} />
                <Text style={s.topToolbarMetaText}>
                  {currentPage > 0 && totalPages > 0
                    ? `${currentPage}/${totalPages}`
                    : `${percent}%`}
                </Text>
              </View>
            </View>
            <View style={s.topToolbarProgressTrack}>
              <View style={[s.topToolbarProgressFill, { width: `${percent}%` }]} />
            </View>
          </View>
        </Animated.View>
      )}

      {/* Selection Popover(精简:复制/AI/发音/词典) */}
      {selectionPopoverSelection && (
        <SelectionPopover
          selection={selectionPopoverSelection}
          onDismiss={handleDismissSelection}
          onCopy={() => {
            setSelection(null);
          }}
          onSpeak={(text, cfi) => {
            tts.startSelectionTTS(text, cfi);
            setSelection(null);
          }}
          onAIChat={() => {
            const selectedText = selectionPopoverSelection.text;
            const chapter = currentChapter;
            setSelection(null);
            navigation.navigate("BookChat", {
              bookId,
              selectedText,
              chapterTitle: chapter,
              selectionCfi: selectionPopoverSelection.cfi,
            });
          }}
          // 划词翻译:外部翻译→词典接口表;内置翻译→标准翻译弹窗(默认提示词)
          onTranslate={(text) => {
            setSelection(null);
            handleTranslateSelection(text);
          }}
        />
      )}

      {/* 内置翻译结果弹窗(查词/取词;外部翻译走词典接口,不经过这里) */}
      <LookupModal
        visible={lookupWord !== null}
        title={lookupWord ?? ""}
        loading={lookupPending}
        result={lookupResult}
        error={lookupError}
        onClose={closeLookup}
      />

      {/* Note Tooltip (long-press on wavy underline) */}
      {adjustedNoteTooltip && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => {
              suppressReaderTapUntilRef.current = Date.now() + 350;
              if (noteTooltipTimer.current) {
                clearTimeout(noteTooltipTimer.current);
                noteTooltipTimer.current = null;
              }
              setNoteTooltip(null);
            }}
          />
          <Pressable
            style={[
              s.noteTooltip,
              {
                left: Math.max(
                  NOTE_TOOLTIP_SIDE_PADDING,
                  Math.min(
                    adjustedNoteTooltip.position.x - NOTE_TOOLTIP_WIDTH / 2,
                    SCREEN_WIDTH - NOTE_TOOLTIP_WIDTH - NOTE_TOOLTIP_SIDE_PADDING,
                  ),
                ),
                ...(adjustedNoteTooltip.position.selectionTop > NOTE_TOOLTIP_TOP_THRESHOLD
                  ? {
                      bottom:
                        SCREEN_HEIGHT -
                        adjustedNoteTooltip.position.selectionTop +
                        NOTE_TOOLTIP_ABOVE_OFFSET,
                    }
                  : {
                      top: adjustedNoteTooltip.position.selectionBottom + NOTE_TOOLTIP_BELOW_OFFSET,
                    }),
              },
            ]}
            onPress={(event) => {
              event.stopPropagation();
              suppressReaderTapUntilRef.current = Date.now() + 550;
            }}
            onPressIn={(event) => {
              event.stopPropagation();
              suppressReaderTapUntilRef.current = Date.now() + 550;
            }}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderTerminationRequest={() => false}
          >
            <View style={s.noteTooltipContent}>
              <MarkdownRenderer
                content={adjustedNoteTooltip.note || ""}
                styleOverrides={noteTooltipMdStyles}
              />
            </View>
          </Pressable>
        </View>
      )}

      {chromeReady && !showSearch && (
        <Animated.View
          pointerEvents={showControls ? "auto" : "none"}
          style={[
            s.floatingTools,
            {
              right: insets.right + 16,
              // 预判三键位置(与控制栏玻璃底一致):浮动条只在控制栏显示时可见,
              // 此时三键必然出现,固定 ≥48 的基准避免三键弹出动画把它顶起
              bottom: Math.max(insets.bottom, 48) + 110,
              opacity: auxToolsOpacity,
              transform: [{ translateY: auxToolsTranslate }],
            },
          ]}
        >
          <TouchableOpacity
            style={[
              s.floatingToolBtn,
              (showChapterTranslation || chapterTranslation.state.status !== "idle") &&
                s.floatingToolBtnActive,
            ]}
            onPress={() => setShowChapterTranslation(true)}
          >
            <LanguagesIcon size={18} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              s.floatingToolBtn,
              (showTTS || ttsPlayState !== "stopped") && s.floatingToolBtnActive,
            ]}
            onPress={tts.handleToggleTTS}
          >
            <HeadphonesIcon size={20} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={s.floatingToolBtn}
            onPress={() => navigation.navigate("BookChat", { bookId })}
            onLongPress={async () => {
              // Long-press = new thread for this book (enters empty chat).
              await useChatStore.getState().createThread(bookId);
              navigation.navigate("BookChat", { bookId });
            }}
            delayLongPress={400}
          >
            <BotIcon size={20} color="#fff" />
          </TouchableOpacity>
        </Animated.View>
      )}

      {!showSearch && !showControls && showBottomTimeBattery && (
        <ReaderBottomInfoBar
          batteryLevel={batteryLevel}
          clock={readerClock}
          chapterLabel={currentChapter || bookTitle}
          currentPage={currentPage}
          totalPages={totalPages}
          progress={progress}
        />
      )}

      {/* ─── Bottom Toolbar ─── */}
      {chromeReady && !showSearch && (
        <Animated.View
          pointerEvents={showControls ? "auto" : "none"}
          style={[
            s.bottomToolbar,
            {
              left: 0,
              right: 0,
              opacity: bottomControlsOpacity,
              transform: [{ translateY: bottomControlsTranslate }],
            },
          ]}
        >
          <View
            style={[
              s.bottomToolbarGlass,
              {
                // 预判三键位置:控制栏显示时三键必然出现(showControls → NavigationBar visible),
                // padding 固定为"三键显示时"的值(≥48+6),不随三键弹出动画的 insets 渐变跳动,
                // 避免内容被系统三键"顶一下"
                paddingBottom: Math.max(insets.bottom, 48) + 6,
                paddingLeft: insets.left + 18,
                paddingRight: insets.right + 18,
              },
            ]}
          >
            <ReadingProgressSlider
              progress={progress}
              onDragStart={() => suppressProgressTracking(99999)}
              onDragEnd={() => suppressProgressTracking(2000)}
              onSeek={(fraction) => {
                bridgeRef.current?.goToFraction(fraction);
              }}
              accentColor={colors.primary}
              trackColor={withOpacity(colors.foreground, 0.12)}
              textColor={withOpacity(colors.foreground, 0.6)}
            />
            <View style={s.bottomDockRow}>
              <TouchableOpacity
                style={s.bottomDockBtn}
                onPress={() => {
                  setTocActiveTab("toc");
                  setShowTOC(true);
                }}
              >
                <ListIcon size={bottomDockIconSize} color={colors.foreground} />
                <Text style={s.bottomDockLabel}>{t("reader.toc", "目录")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.bottomDockBtn, isBookmarked && s.bottomDockBtnActive]}
                onPress={handleToggleBookmark}
              >
                {isBookmarked ? (
                  <BookmarkFilledIcon size={bottomDockIconSize} color={colors.primary} />
                ) : (
                  <BookmarkIcon size={bottomDockIconSize} color={colors.foreground} />
                )}
                <Text style={[s.bottomDockLabel, isBookmarked && s.bottomDockLabelActive]}>
                  {t("reader.bookmarks", "书签")}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.bottomDockBtn}
                onPress={() => navigation.navigate("FullScreenNotes", { bookId })}
              >
                <NotebookPenIcon size={bottomDockIconSize} color={colors.foreground} />
                <Text style={s.bottomDockLabel}>{t("notes.title", "笔记")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.bottomDockBtn}
                onPress={() => {
                  setShowSearch(true);
                  setShowControls(false);
                  Animated.timing(toolbarAnim, {
                    toValue: TOOLBAR_HIDE_OFFSET,
                    duration: 180,
                    easing: Easing.out(Easing.cubic),
                    useNativeDriver: true,
                  }).start();
                }}
              >
                <SearchIcon size={bottomDockIconSize} color={colors.foreground} />
                <Text style={s.bottomDockLabel}>{t("reader.search", "搜索")}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.bottomDockBtn} onPress={() => setShowSettings(true)}>
                <SettingsIcon size={bottomDockIconSize} color={colors.foreground} />
                <Text style={s.bottomDockLabel}>{t("common.settings", "设置")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Animated.View>
      )}

      {/* ─── Search Bar ─── */}
      {showSearch && (
        <View style={[s.searchBarWrap, { paddingTop: insets.top }]}>
          <View style={s.searchBarRow}>
            <View style={s.searchInputWrap}>
              <SearchIcon size={16} color={colors.mutedForeground} />
              <TextInput
                style={s.searchInput}
                placeholder={t("reader.searchInBook", "在书中搜索")}
                placeholderTextColor={colors.mutedForeground}
                value={search.searchQuery}
                onChangeText={search.handleSearchInput}
                autoFocus
                returnKeyType="search"
              />
            </View>
            <View style={s.searchMetaRow}>
              {search.isSearching ? (
                <ActivityIndicator size="small" color={colors.mutedForeground} />
              ) : search.searchQuery && search.searchResultCount > 0 ? (
                <Text style={s.searchCount}>
                  {search.searchIndex + 1} / {search.searchResultCount}
                </Text>
              ) : search.searchQuery && !search.isSearching ? (
                <Text style={s.searchCount}>0</Text>
              ) : null}
            </View>
            <TouchableOpacity
              style={s.searchNavBtn}
              onPress={() => search.navigateSearch("prev")}
              disabled={search.searchResultCount === 0}
            >
              <ChevronLeftIcon
                size={16}
                color={search.searchResultCount > 0 ? colors.foreground : colors.mutedForeground}
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={s.searchNavBtn}
              onPress={() => search.navigateSearch("next")}
              disabled={search.searchResultCount === 0}
            >
              <ChevronRightIcon
                size={16}
                color={search.searchResultCount > 0 ? colors.foreground : colors.mutedForeground}
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={s.searchNavBtn}
              onPress={() => {
                if (search.searchStartCfi && search.searchResultCount > 0) {
                  Alert.alert(
                    t("reader.searchComplete", "搜索完成"),
                    t("reader.returnToOriginal", "是否返回搜索前的位置？"),
                    [
                      {
                        text: t("common.cancel", "取消"),
                        style: "cancel",
                        onPress: () => {
                          search.setSearchStartCfi(null);
                        },
                      },
                      {
                        text: t("common.confirm", "确定"),
                        onPress: () => {
                          goToCFISafely(search.searchStartCfi!);
                          search.setSearchStartCfi(null);
                        },
                      },
                    ],
                  );
                } else {
                  search.setSearchStartCfi(null);
                }
                setShowSearch(false);
                search.clearSearch();
                setShowControls(true);
                Animated.timing(toolbarAnim, {
                  toValue: 0,
                  duration: 180,
                  easing: Easing.out(Easing.cubic),
                  useNativeDriver: true,
                }).start();
              }}
            >
              <XIcon size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ─── TOC & Bookmarks Panel ─── */}
      <ReaderTOCPanel
        visible={showTOC}
        activeTab={tocActiveTab}
        toc={toc}
        bookmarks={bookBookmarks}
        currentChapter={currentChapter}
        onClose={() => setShowTOC(false)}
        onTabChange={setTocActiveTab}
        onSelectTocItem={goToTocItem}
        onGoToBookmark={(cfi) => {
          goToCFISafely(cfi);
          setShowTOC(false);
        }}
        onDeleteBookmark={(id) => removeBookmark(id)}
      />

      {/* ─── Settings Panel ─── */}
      <ReaderSettingsPanel
        visible={showSettings}
        readSettings={readSettings}
        bookId={bookId}
        onClose={() => setShowSettings(false)}
        onUpdateSetting={updateSetting}
        onRubyModeChange={async (mode) => {
          if (mode) {
            // Load dicts into WebView if not already done
            try {
              const { readDictStrings } = await import("@/lib/ruby/dict-service-mobile");
              const { wordDict, charDict } = await readDictStrings();
              if (wordDict || charDict) {
                bridge.setRubyDicts(wordDict, charDict);
                // Small delay to let WebView process the dict
                setTimeout(() => bridge.injectRuby(mode), 100);
              }
            } catch (err) {
              console.error("[ReaderScreen] Ruby dict load failed:", err);
            }
          } else {
            bridge.removeRuby();
          }
        }}
      />

      {/* ─── Notebook Panel ─── */}
      <Modal
        visible={showNotebook}
        transparent
        animationType="slide"
        onRequestClose={() => setShowNotebook(false)}
      >
        <Pressable style={s.modalBackdrop} onPress={() => setShowNotebook(false)} />
        <View
          style={[
            s.bottomSheet,
            { maxHeight: SCREEN_HEIGHT * 0.7, paddingBottom: insets.bottom || 16 },
          ]}
        >
          <View style={s.sheetHeader}>
            <Text style={s.sheetTitle}>{t("reader.notebook", "笔记本")}</Text>
            <TouchableOpacity onPress={() => setShowNotebook(false)}>
              <XIcon size={18} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          {highlights.length > 0 ? (
            <ScrollView showsVerticalScrollIndicator={false} style={s.sheetScroll}>
              {highlights.map((h) => (
                <View key={h.id} style={s.highlightItem}>
                  <View
                    style={[
                      s.highlightColorDot,
                      {
                        backgroundColor:
                          h.color === "yellow"
                            ? "#facc15"
                            : h.color === "green"
                              ? "#4ade80"
                              : h.color === "blue"
                                ? "#60a5fa"
                                : h.color === "pink"
                                  ? "#ec4899"
                                  : h.color === "red"
                                    ? "#f87171"
                                    : "#a78bfa",
                      },
                    ]}
                  />
                  <View style={s.highlightContent}>
                    <Text style={s.highlightText} numberOfLines={3}>
                      {h.text}
                    </Text>
                    {h.note && <Text style={s.highlightNote}>{h.note}</Text>}
                  </View>
                </View>
              ))}
            </ScrollView>
          ) : (
            <View style={s.notebookPlaceholder}>
              <NotebookPenIcon size={40} color={colors.mutedForeground} />
              <Text style={s.notebookPlaceholderText}>
                {t("reader.notebookHint", "在阅读时选中文字来创建笔记和高亮")}
              </Text>
            </View>
          )}
        </View>
      </Modal>

      {/* ─── Note View Modal ─── */}
      <ReaderNoteViewModal
        highlight={noteViewHighlight}
        editing={noteViewEditing}
        editContent={noteViewContent}
        bookId={bookId}
        onClose={() => {
          setNoteViewHighlight(null);
          setNoteViewEditing(false);
        }}
        onStartEdit={() => {
          setNoteViewContent(noteViewHighlight?.note || "");
          setNoteViewEditing(true);
        }}
        onCancelEdit={() => {
          setNoteViewEditing(false);
          setNoteViewContent(noteViewHighlight?.note || "");
        }}
        onContentChange={setNoteViewContent}
        onSave={(highlight, newNote) => {
          bridge.removeAnnotation({ value: highlight.cfi });
          bridge.addAnnotation({
            value: highlight.cfi,
            type: "highlight",
            color: highlight.color,
            note: newNote,
          });
          setNoteViewHighlight({ ...highlight, note: newNote });
          setNoteViewEditing(false);
        }}
      />

      {/* ─── Translation Panel ─── */}
      {showTranslation && translationText && (
        <TranslationPanel
          text={translationText}
          onClose={() => {
            setShowTranslation(false);
            setTranslationText("");
          }}
        />
      )}

      {/* ─── Chapter Translation Sheet ─── */}
      <ChapterTranslationSheet
        visible={showChapterTranslation}
        onClose={() => setShowChapterTranslation(false)}
        state={chapterTranslation.state}
        onStart={chapterTranslation.startTranslation}
        onCancel={chapterTranslation.cancelTranslation}
        onToggleOriginalVisible={chapterTranslation.toggleOriginalVisible}
        onToggleTranslationVisible={chapterTranslation.toggleTranslationVisible}
        onClear={chapterTranslation.clearTranslation}
      />

      <TTSPage
        visible={showTTS}
        bookTitle={bookTitle || book?.meta.title || ""}
        chapterTitle={currentChapter}
        coverUri={tts.ttsCoverUri}
        playState={ttsPlayState}
        currentText={tts.currentTTSSegment?.text || tts.ttsLastText}
        config={ttsConfig}
        readingProgress={progress}
        currentPage={currentPage}
        totalPages={totalPages}
        sourceLabel={tts.ttsSourceLabel}
        continuousEnabled={tts.ttsContinuousEnabled}
        narrationSegments={tts.ttsDisplaySegments}
        prevNarrationSegments={tts.ttsPrevPageSegments}
        currentSegmentCfi={tts.resolvedTTSSegmentCfi}
        currentSegmentText={tts.currentTTSSegment?.text || null}
        currentChunkIndex={tts.localTTSChunkIndex}
        totalChunks={tts.ttsDisplaySegments.length}
        onClose={() => setShowTTS(false)}
        onReturnToReading={tts.handleTTSReturnToReading}
        onReplay={tts.handleTTSReplay}
        onPlayPause={tts.handleTTSPlayPause}
        onJumpToSegment={tts.handleJumpToTTSSegment}
        onJumpToLyricSegment={tts.handleJumpToTTSLyricSegment}
        onLoadMoreAbove={tts.handleLoadMoreAboveTTSLyrics}
        onLoadMoreBelow={tts.handleLoadMoreBelowTTSLyrics}
        onStop={tts.handleTTSStop}
        onAdjustRate={tts.handleAdjustTTSRate}
        onAdjustPitch={tts.handleAdjustTTSPitch}
        onToggleContinuous={tts.handleToggleTTSContinuous}
        onUpdateConfig={tts.handleUpdateTTSConfig}
        onPrevChapter={toc.length > 0 ? tts.handleTTSPrevChapter : undefined}
        onNextChapter={toc.length > 0 ? tts.handleTTSNextChapter : undefined}
      />
    </View>
  );
}
