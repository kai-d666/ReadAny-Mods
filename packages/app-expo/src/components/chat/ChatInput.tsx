import { BrainIcon, EyeOffIcon, SendIcon, StopCircleIcon, XIcon } from "@/components/ui/Icon";
import { useKeyboardInsets } from "@/hooks/use-keyboard-insets";
import { useSettingsStore } from "@/stores/settings-store";
import { ToolPrefsMenu } from "./ToolPrefsMenu";
import { fontSize as fs, fontWeight, radius, useColors, withOpacity } from "@/styles/theme";
import type { ThemeColors } from "@/styles/theme";
import type { AIChatMode, AttachedQuote } from "@readany/core/types";
/**
 * ChatInput — 双层结构(2026-08-31 用户设计):
 * 上层圆角输入卡(纯输入框+右发送钮),下层功能卡(两行按钮)默认完全藏在输入卡之下;
 * 拖动输入卡顶部"滑块槽"(人机验证滑块样式)→ 整个组合体上移,下层卡从底部"拽出";
 * 松手吸附(过半或快甩展开);键盘弹出 → 下层自动收回。
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useIsFocused } from "@react-navigation/native";
import Animated, {
  Easing,
  interpolateColor,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

/** 段顺序(左→右):标准 / Lite / K-O(用户 2026-08-31) */
const MODE_IDX: Record<AIChatMode, number> = { standard: 0, lite: 1, knowledge: 2 };
const MODES: AIChatMode[] = ["standard", "lite", "knowledge"];
const SEG_LABEL_KEYS = ["chatModeStandard", "chatModeLite", "chatModeKnowledge"] as const;
/** 滑块弹簧(带微过冲);按压缩放弹簧 */
const SLIDE_SPRING = { damping: 14, stiffness: 200, mass: 0.5 };
const PRESS_SPRING = { damping: 12, stiffness: 180, mass: 0.6 };

/**
 * ModeSlider — 模式切换滑动开关(用户设计 2026-08-31):
 * 三个模式横排一段(轨道胶囊凹陷感),白色滑块(1/3 宽)可整轨拖动/点击段/弹簧吸附;
 * 按下载入即跳到手指下("立即跟手"),松手吸附最近段;段文字颜色随滑块距离渐变。
 */
function ModeSlider({
  mode,
  onChange,
}: {
  mode: AIChatMode;
  onChange: (m: AIChatMode) => void;
}) {
  const { t } = useTranslation();
  const colors = useColors();
  const st = makeStyles(colors);
  const [trackW, setTrackW] = useState(0);
  const [thumbW, setThumbW] = useState(0);
  const trackWSV = useSharedValue(0); // worklet 镜像
  const thumbX = useSharedValue(0); // 滑块中心 x
  const scale = useSharedValue(1);
  const startX = useSharedValue(0);

  // 外部 mode 变化(如设置页)或首次测量:滑块飞向对应段
  useEffect(() => {
    if (trackW <= 0) return;
    const target = (MODE_IDX[mode] + 0.5) * (trackW / 3);
    thumbX.value = withSpring(target, SLIDE_SPRING);
  }, [mode, trackW, thumbX]);

  const segW = trackW / 3;

  // 证据驱动重写(用户 2026-08-31 拍板):
  // - 日志证实 Tap 从未赢过(Race 无意义),Pan 点击/拖动每次都会 ended → 单 Pan 二合一
  // - 段计算用手指终位 e.x(点击/拖动都准)
  // - 吸附与切换解耦:reaction 无条件弹簧吸附,仅"段变了"才回调(onChange)
  const pendingIdx = useSharedValue(-1);
  // 稳定 JS 函数(传入 worklet 的只能是不变引用,不用 ref 对象)
  const logEvt = useCallback((tag: string, ...vals: number[]) => {
    console.log(`[ModeSlider] ${tag}=${vals.join(",")}`);
  }, []);

  // 点击检测(RNGH 低阶 onTouchesUp 在未激活松手也触发;激活标志区分:拖动走 onEnd,点击走 touchesUp)
  const everActivated = useSharedValue(false);
  const gesture = useRef(
    Gesture.Pan()
      .activeOffsetX([-8, 8])
      .failOffsetY([-16, 16])
      .onTouchesDown(() => {
        everActivated.value = false;
        scale.value = withSpring(1.06, PRESS_SPRING);
      })
      .onStart(() => {
        everActivated.value = true;
        startX.value = thumbX.value;
      })
      .onUpdate((e) => {
        const t = trackWSV.value;
        const w = Math.max(1, t / 3 - 6);
        const half = w / 2;
        thumbX.value = Math.min(t - half, Math.max(half, startX.value + e.translationX));
      })
      .onEnd((e) => {
        scale.value = withSpring(1, PRESS_SPRING);
        const segWv = trackWSV.value / 3;
        const i = Math.min(2, Math.max(0, Math.round((e.x - segWv / 2) / segWv)));
        // 吸附必须每次松手都执行(同段松手也回中:reaction 只随"值变化"跑,靠不住)
        thumbX.value = withSpring((i + 0.5) * segWv, SLIDE_SPRING);
        pendingIdx.value = i;
        runOnJS(logEvt)("panEnd", i, Math.round(e.x), Math.round(thumbX.value));
      })
      .onTouchesUp((e) => {
        if (everActivated.value) return; // 拖动已由 onEnd 处理
        const tt = e.changedTouches[0] ?? e.allTouches?.[0];
        scale.value = withSpring(1, PRESS_SPRING);
        const segWv = trackWSV.value / 3;
        const i = Math.min(
          2,
          Math.max(0, Math.round(((tt ? tt.x : 0) - segWv / 2) / segWv)),
        );
        thumbX.value = withSpring((i + 0.5) * segWv, SLIDE_SPRING);
        pendingIdx.value = i;
        runOnJS(logEvt)("tap", i, tt ? Math.round(tt.x) : -1);
      }),
  ).current;

  // 切换回调(吸附已在 onEnd;这里只做"段变化时切换一次")
  useAnimatedReaction(
    () => pendingIdx.value,
    (next, prev) => {
      if (next < 0 || next === prev) return;
      runOnJS(logEvt)("apply", next);
      runOnJS(onChange)(MODES[next]);
    },
  );

  // 段文字颜色:至滑块中心的距离 → primary↔muted 渐变
  const primaryColor = colors.primary;
  const mutedColor = colors.mutedForeground;
  const kLabelStyle = useAnimatedStyle(() => ({
    color: interpolateColor(
      Math.abs(thumbX.value - 0.5 * (trackWSV.value / 3)),
      [0, (trackWSV.value / 3) * 0.5],
      [primaryColor, mutedColor],
    ),
  }));
  const sLabelStyle = useAnimatedStyle(() => ({
    color: interpolateColor(
      Math.abs(thumbX.value - 1.5 * (trackWSV.value / 3)),
      [0, (trackWSV.value / 3) * 0.5],
      [primaryColor, mutedColor],
    ),
  }));
  const lLabelStyle = useAnimatedStyle(() => ({
    color: interpolateColor(
      Math.abs(thumbX.value - 2.5 * (trackWSV.value / 3)),
      [0, (trackWSV.value / 3) * 0.5],
      [primaryColor, mutedColor],
    ),
  }));

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: thumbX.value - thumbW / 2 },
      { scale: scale.value },
    ],
  }));

  return (
    <View
      style={[st.modeSliderTrack]}
      onLayout={(e) => {
        // 统一用"内容区宽"(外宽-边框2-内边距6):段以 flex 均分,thumb 同基准
        const inner = Math.round(e.nativeEvent.layout.width) - 8;
        setTrackW(inner);
        trackWSV.value = Math.max(1, inner);
        setThumbW(Math.round(inner / 3 - 6));
      }}
    >
      <GestureDetector gesture={gesture}>
        <View style={st.modeSliderSegs}>
          {SEG_LABEL_KEYS.map((key, i) => (
            <View key={key} style={[st.modeSliderSeg, { flex: 1 }]}>
              <Animated.Text
                style={[st.modeSliderLabel, [kLabelStyle, sLabelStyle, lLabelStyle][i]]}
                numberOfLines={1}
                maxFontSizeMultiplier={1.3}
              >
                {t(key)}
              </Animated.Text>
            </View>
          ))}
          <Animated.View style={[st.modeSliderThumb, thumbStyle, { width: thumbW, height: 24 }]} />
        </View>
      </GestureDetector>
    </View>
  );
}

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
  /** 切换模式/深思考/防剧透时的顶部提示(仅在切换瞬间调用) */
  onNotice?: (text: string) => void;
}

const SINGLE_LINE_INPUT_HEIGHT = 46;
const MAX_INPUT_HEIGHT = 112;
const INPUT_PADDING_VERTICAL = 16;
/** 展开行程(上层上移距离;下层随之被"拉长",动态跟随所以行程可独立取值) */
const PULL_T = { duration: 200, easing: Easing.out(Easing.cubic) };

export function ChatInput({
  onSend,
  onStop,
  isStreaming,
  quotes = [],
  onRemoveQuote,
  placeholder,
  keyboardBottomOffset = 0,
  variant = "general",
  onNotice,
}: ChatInputProps) {
  const [text, setText] = useState("");
  const [deepThinking, setDeepThinking] = useState(false);
  const [inputHeight, setInputHeight] = useState(SINGLE_LINE_INPUT_HEIGHT);
  const [expanded, setExpanded] = useState(false);
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

  /* ── 上层输入卡上拉(lift: 0 → -rig/2)与展开态 ──
   * 下层卡=半张卡(顶=上层中心线 top:50%,底=上层下边初始 bottom:0);
   * 展开距离 = 下层卡自身高 = rig/2 —— 拉满恰好全露出,零空带 */
  const lift = useSharedValue(0);
  const startLift = useSharedValue(0);
  const [rigH, setRigH] = useState(150);
  // worklet 镜像:展开距离 = rig 高一半
  const rigSV = useSharedValue(150);
  /** 展开行程 = 工具面板(onLayout)实测内容高度,替代固定常量 */
  const expandSV = useSharedValue(150);
  // 键盘"新弹出"边沿 → 下层自动收回(键盘优先,组合体已被键盘顶起;仅边沿触发,
  // 避免展开拖拽中(键盘已可见)被自己的 effect 抢收)
  const prevKeyboardVisible = useRef(false);
  useEffect(() => {
    const justShown = keyboardInsets.isVisible && !prevKeyboardVisible.current;
    prevKeyboardVisible.current = keyboardInsets.isVisible;
    if (justShown) {
      lift.value = withTiming(0, PULL_T);
      setExpanded(false);
    }
  }, [keyboardInsets.isVisible, lift]);

  // 离开聊天页面(切 tab/返回)即恢复原样:展开态立刻收起(用户 2026-08-31)
  const isFocused = useIsFocused();
  useEffect(() => {
    if (isFocused) return;
    lift.value = withTiming(0, PULL_T);
    setExpanded(false);
  }, [isFocused, lift]);

  const dragSlotGesture = useRef(
    Gesture.Pan()
      .activeOffsetY([-10, 10])
      .failOffsetX([-24, 24])
      .onStart(() => {
        startLift.value = lift.value;
      })
      .onUpdate((e) => {
        lift.value = Math.max(-expandSV.value, Math.min(0, startLift.value + e.translationY));
      })
      .onEnd((e) => {
        const open = lift.value < -expandSV.value * 0.5 || e.velocityY < -400;
        const target = open ? -expandSV.value : 0;
        lift.value = withTiming(target, PULL_T);
        runOnJS(setExpanded)(open);
      }),
  ).current;

  // 运动:上层输入卡整体上移;下层上边缘 = 上层实时中心线(跟随,永不脱节),
  // 下层底边保持静态(盒底)。top 用动画值:rig/2 + lift
  const comboStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: lift.value }],
  }));
  const panelStyle = useAnimatedStyle(() => ({
    top: rigSV.value / 2 + lift.value,
  }));
  // 工具行锚点=上层卡下边缘(动态):top = rigH + lift(与 combo 底边同步);
  // 初始(rigH,屏底之下)被 wrapper 裁剪不可见;拖动时随上层底边一起拉出
  const toolStyle = useAnimatedStyle(() => ({
    top: rigSV.value + lift.value,
  }));

  // 防剧透开关按聊天上下文(general/book)持久记忆,发送后不重置(移植自桌面 ea0bd55)
  const aiConfig = useSettingsStore((st) => st.aiConfig);
  const updateAIConfig = useSettingsStore((st) => st.updateAIConfig);
  const spoilerFree = aiConfig.spoilerFree[variant];
  const chatMode = aiConfig.chatMode ?? "knowledge";

  // onNotice 用 ref 保最新(回调常读,避免闭包过期)
  const onNoticeRef = useRef<((text: string) => void) | undefined>(undefined);
  onNoticeRef.current = onNotice;
  const handleToggleSpoilerFree = useCallback(() => {
    const next = !spoilerFree;
    updateAIConfig({
      spoilerFree: { ...aiConfig.spoilerFree, [variant]: next },
    });
    if (next) {
      onNoticeRef.current?.(t("chat.spoilerFreeHint", "AI 将避免透露当前阅读进度之后的内容"));
    }
  }, [aiConfig.spoilerFree, variant, updateAIConfig, spoilerFree, t]);

  // 模式切换(ModeSlider 回调):写配置 + 弹对应提示
  const handleModeChange = useCallback(
    (next: AIChatMode) => {
      if (next === chatMode) return;
      updateAIConfig({ chatMode: next });
      const hint =
        next === "knowledge"
          ? t("chatModeKnowledgeHint", "Knowledge-Only: 基于模型知识回答,不检索原文")
          : next === "lite"
            ? t("chatModeLiteHint", "快速直连模式")
            : t("chatModeStandardHint", "标准模式:完整功能对话(默认)");
      onNoticeRef.current?.(hint);
    },
    [chatMode, updateAIConfig, t],
  );
  const toggleDeepThinking = useCallback(() => {
    setDeepThinking((prev) => {
      const next = !prev;
      if (next) {
        onNoticeRef.current?.(t("chat.deepThinkingHint", "深度思考模式会使用更多 tokens"));
      }
      return next;
    });
  }, [t]);

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
      // Android 的 contentSize 已含内边距,不再叠加;单行时保持初始尺寸,换行后才增高
      const totalHeight =
        contentHeight + (Platform.OS === "ios" ? INPUT_PADDING_VERTICAL : 0);
      const h = Math.min(totalHeight, MAX_INPUT_HEIGHT);
      setInputHeight(Math.max(SINGLE_LINE_INPUT_HEIGHT, h));
    },
    [text],
  );

  const canSend = text.trim().length > 0 || quotes.length > 0;

  // Android edge-to-edge:键盘弹出时窗口不 resize。
  // 输入栏恒 absolute 悬浮(不参与布局,背景零重排;不用 transform,避免 Android TextInput
  // 光标/输入法连接错位),bottom 随键盘状态切换;消息列表由 MessageList 恒留 120dp 占位,
  // 键盘弹出前后列表尺寸完全一致,背景永不跳变。
  const floatUp = Platform.OS === "android";

  return (
    <View
      style={[
        s.wrapper,
        floatUp
          ? { position: "absolute", left: 0, right: 0, bottom: bottomPadding }
          : { paddingBottom: bottomPadding },
      ]}
    >
      {/* 解耦后的双层:layerPanel 独立于 combo(不随上层平移),两者同挂 rig;
          upper 的运动层 combo 独立 translateY,rig 高度=上层内容高(端点:左/右/底/中心线) */}
      <View style={s.rig}>
        {/* 下层功能卡:底边=盒底(静态);上边缘=上层实时中心线(动态跟随 lift)——
            初始与上层下半叠合被盖;拖动时上边缘随上层中线爬升,下层被"拉长"露出 */}
        <Animated.View style={[s.layerPanel, panelStyle]} pointerEvents="none" />

        {/* 工具行(独立层):锚点=上层卡上边缘(动态 lift 同步);悬于上层卡之上 */}
        <Animated.View
          style={[s.toolArea, toolStyle]}
          pointerEvents={expanded ? "auto" : "none"}
          onLayout={(e) => {
            // 样式一致性:面板内容高度 = 展开行程(替代常量 116)
            expandSV.value = Math.max(96, Math.round(e.nativeEvent.layout.height));
          }}
        >
          {/* 行1:[模式滑条(左)] · 深度思考(右,钉死) */}
          <View style={s.toggleRowBetween}>
            <ModeSlider mode={chatMode} onChange={handleModeChange} />

            <TouchableOpacity
              style={[s.deepThinkBtn, s.pushedRight, deepThinking && s.deepThinkBtnActive]}
              onPress={toggleDeepThinking}
              activeOpacity={0.7}
            >
              <BrainIcon size={13} color={deepThinking ? colors.primary : colors.mutedForeground} />
              <Text style={[s.deepThinkText, deepThinking && s.deepThinkTextActive]}>
                {t("chat.deepThinking", "深度思考")}
              </Text>
            </TouchableOpacity>
          </View>

          {/* 行2:工具(左) · 防剧透(右,钉死) */}
          <View style={s.toggleRowBetween}>
            <ToolPrefsMenu chatMode={chatMode} />

            <TouchableOpacity
              style={[s.deepThinkBtn, s.pushedRight, spoilerFree && s.deepThinkBtnActive]}
              onPress={handleToggleSpoilerFree}
              activeOpacity={0.7}
            >
              <EyeOffIcon size={13} color={spoilerFree ? colors.primary : colors.mutedForeground} />
              <Text style={[s.deepThinkText, spoilerFree && s.deepThinkTextActive]}>
                {t("chat.spoilerFree", "防剧透")}
              </Text>
            </TouchableOpacity>
          </View>
        </Animated.View>

        {/* 上层输入卡(唯一运动层):拖动经卡顶小手柄;下层完全安静,上层移开后露出它 */}
        <Animated.View
          style={[comboStyle, s.combo]}
          onLayout={(e) => {
            const h = Math.round(e.nativeEvent.layout.height);
            setRigH(h);
            rigSV.value = Math.max(1, h);
          }}
        >
        <View style={s.container}>
          {/* 顶边拖动手柄:小圆角条,热区横贯,上下拖动跟手 */}
          <GestureDetector gesture={dragSlotGesture}>
            <View style={s.dragSlot} hitSlop={{ top: 6, bottom: 2 }}>
              <View style={s.dragHint} />
            </View>
          </GestureDetector>

          {/* 模式/深思考/防剧透说明改为「切换时顶部提示几秒」(见父页面 modeNotice);
              不再有常驻文字 */}

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

          {/* Input area: text + right round send */}
          <View style={s.inputRow}>
            <TextInput
              ref={inputRef}
              style={[s.input, { height: inputHeight }]}
              placeholder={
                quotes.length > 0
                  ? t("chat.askAboutQuote", "关于引用提问...")
                  : placeholder || t("chat.inputPlaceholder", "输入消息...")
              }
              placeholderTextColor={colors.mutedForeground}
              includeFontPadding={false} // 统一字体内边距,避免 placeholder 与输入文字垂直错位
              value={text}
              onChangeText={handleTextChange}
              multiline
              onContentSizeChange={handleContentSizeChange}
              returnKeyType="default"
              blurOnSubmit={false}
              editable={!isStreaming}
            />
            <View style={s.actionButtons}>
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
        </Animated.View>

      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrapper: {
      // 停靠容器:整个双层停靠底部;overflow 裁剪下层下垂段;唯一缩进(paddingHorizontal)
      paddingHorizontal: 12,
      height: 400,
      overflow: "hidden",
      justifyContent: "flex-end",
    },
    /* 解耦定位盒:高度=上层(combo)内容高(自动跟随),下层 absolute 以它为端点基准 */
    rig: {
      width: "100%",
    },
    combo: {
      zIndex: 1,
    },
    container: {
      zIndex: 1,
      borderRadius: 32,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      shadowColor: colors.foreground,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.08,
      shadowRadius: 6,
      elevation: 2,
      overflow: "hidden",
    },
    /* 下层功能卡:显示区以上层(输入卡)下边线为界——top:100% 紧贴上卡底边,
       顶边不收圆角(直边),被盖住区零内容(无上移穿透);露出部分=左右直边+大圆角底边 */
    /* 下层卡体(仅背景/直边/圆角;上边缘为动画值 rig/2+lift) */
    layerPanel: {
      position: "absolute",
      zIndex: 0,
      left: 0,
      right: 0,
      bottom: 0, // 下层下边 = 上层下边初始位置(静态端点;上边缘为动画值 rig/2+lift)
      borderTopWidth: 0,
      borderLeftWidth: 1,
      borderRightWidth: 1,
      borderBottomWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      borderBottomLeftRadius: 32,
      borderBottomRightRadius: 32,
      paddingTop: 14,
      paddingBottom: 14,
      paddingHorizontal: 12,
      gap: 8,
    },
    /* 工具行(独立层):锚点=上层卡上边缘(动画 top 与 lift 同步),悬于上层之上 */
    toolArea: {
      position: "absolute",
      zIndex: 2,
      left: 0,
      right: 0,
      paddingHorizontal: 12,
      paddingTop: 14,
      gap: 8,
    },
    toggleRowBetween: {
      flexDirection: "row",
      alignItems: "center",
    },
    /* 右列钉死右侧:即便左列(工具)缺失也稳定右对齐,不跳位 */
    pushedRight: {
      marginLeft: "auto",
    },
    /* 模式切换滑条(缩小版:宽 190 左对齐,轨道高 30,同比例) */
    modeSliderTrack: {
      width: 190,
      alignSelf: "flex-start",
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: withOpacity(colors.muted, 0.6),
      padding: 3,
      overflow: "hidden",
    },
    modeSliderSegs: {
      flexDirection: "row",
      height: 24,
      position: "relative",
    },
    modeSliderSeg: {
      alignItems: "center",
      justifyContent: "center",
    },
    modeSliderLabel: {
      fontSize: fs.xs,
      fontWeight: fontWeight.medium,
    },
    modeSliderThumb: {
      position: "absolute",
      left: 0,
      top: 0,
      borderRadius: 999,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.1,
      shadowRadius: 3,
      elevation: 3,
    },
    /* 顶边拖动手柄:热区横贯整卡,视觉为中央小圆角条 */
    dragSlot: {
      height: 22,
      alignItems: "center",
      justifyContent: "center",
    },
    dragHint: {
      width: 44,
      height: 5,
      borderRadius: 2.5,
      backgroundColor: withOpacity(colors.mutedForeground, 0.35),
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
    inputRow: {
      flexDirection: "row",
      alignItems: "flex-end",
    },
    input: {
      flex: 1,
      fontSize: fs.sm,
      color: colors.foreground,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 6,
      minHeight: SINGLE_LINE_INPUT_HEIGHT,
      maxHeight: MAX_INPUT_HEIGHT,
      // 不设 lineHeight:Android 上输入文本会因行盒内居中而比 placeholder(系统绘制)低半个行高差
      textAlignVertical: "top",
    },
    actionButtons: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingRight: 12,
      paddingBottom: 10,
    },
    deepThinkBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 10,
      paddingVertical: 6,
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
  });
