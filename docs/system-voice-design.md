> 状态:done(已落地:core/tts engine="system" + systemVoiceLabel 实现)

# 系统语音方案设计

## 一、背景

当前项目的朗读能力分成三类：

- **桌面端系统语音**：`packages/app/src/lib/tts/tts-service.ts` 里通过浏览器 `speechSynthesis` 提供，当前在配置层被命名为 `browser`
- **移动端系统语音**：`packages/app-expo/src/lib/platform/expo-speech-player.ts` 里通过 `expo-speech` 提供
- **云端语音**：`Edge TTS` 与 `DashScope TTS`

这套结构已经能工作，但存在几个明显问题：

- `browser` 这个命名不准确。对用户来说，这是“系统语音”，不是“浏览器语音”
- 桌面端系统语音仍然依赖 WebView 的 `speechSynthesis`，在 macOS / Windows / Linux 上的能力和一致性较弱
- 移动端虽然已经用上原生系统语音，但还缺少完整的语音枚举、语言筛选、质量标记和设备差异处理
- `TTSConfig` 目前只有 `voiceName`，不足以表达系统语音的来源、语言、质量、平台能力等信息
- UI 上尚未形成“系统语音”和“云端语音”并列的清晰模型

这个方案的目标是把 **系统语音** 提升为一等能力，并在 Tauri 桌面端与 Expo 移动端下形成统一抽象。

## 二、目标

### 目标

- 将当前 `browser` 引擎升级为语义更准确的 `system` 引擎
- 在 **Tauri** 下接入原生系统语音，而不是继续依赖浏览器 `speechSynthesis`
- 在 **Expo** 下保留 `expo-speech`，并补齐系统语音枚举与元数据能力
- 提供统一的 `SystemVoice` 数据结构，支撑桌面端和移动端同一套 UI
- 在设置页、朗读页、歌词页内统一展示系统语音
- 保留 `Edge` 和 `DashScope`，将其视为“云端语音”能力而不是替代系统语音

### 非目标

- 第一阶段不做自建离线语音包下载器
- 第一阶段不尝试解决 Linux 各发行版缺失语音引擎的安装问题
- 第一阶段不替换现有 `Edge` / `DashScope` 的播放链路
- 第一阶段不追求多端完全相同的 voice ID，只追求统一模型和稳定回退

## 三、平台调研结论

### 1. Tauri 桌面端

### macOS

- 底层可使用 Apple 系统语音能力
- 系统自带语音最丰富，通常支持更多语言、更高质量语音包
- 是桌面端系统语音体验最好的平台

### Windows

- 可使用系统安装的语音列表
- 整体语音质量和语种覆盖较好
- 语音能力依赖用户是否安装语言包和语音组件

### Linux

- 没有统一且丰富的“系统自带语音包”概念
- 实际能力通常依赖 `Speech Dispatcher`、`eSpeak NG`、`RHVoice` 等后端
- 可播放不代表体验好，语言质量和可用性会明显分化

### 桌面端选型结论

推荐优先采用：

- **Rust `tts` crate + 自定义 Tauri commands**

备选方案：

- `tauri-plugin-tts`

不推荐继续作为主方案的方式：

- 单纯依赖浏览器 `speechSynthesis`

原因：

- `tts` crate 的控制边界更清晰，适合我们按自己的状态机与事件协议封装
- `tauri-plugin-tts` 可以作为调研分支或对照实现，但它仍然是第三方插件，当前不应比自有命令链路更优先
- WebView `speechSynthesis` 无法给我们稳定的跨平台能力，也不利于后续统一 voice metadata

### 2. Expo 移动端

### iOS

- `expo-speech` 能直接使用系统语音
- iOS 系统语音库丰富，质量好
- 支持 `getAvailableVoicesAsync()`，适合做语音选择器

### Android

- `expo-speech` 同样可以直接使用系统语音
- 语音能力很依赖设备已安装的 TTS engine 和 voice data
- 不同品牌、不同 ROM 的语音列表和质量会明显不同

### 移动端选型结论

推荐第一阶段继续采用：

- **`expo-speech`**

第二阶段可选增强：

- **`react-native-tts`**

原因：

- `expo-speech` 已经在当前项目中工作，且与 Expo 架构兼容最好
- 我们当前最缺的是统一 voice metadata、语言筛选和配置持久化，而不是立刻更换底层库
- `react-native-tts` 更适合后续 Android 进阶控制，例如枚举 engines、提示安装语音数据、切换默认引擎

## 四、现有架构问题

当前共享 TTS 配置定义在 `packages/core/src/tts/types.ts`：

```ts
export type TTSEngine = "browser" | "edge" | "dashscope";

export interface TTSConfig {
  engine: TTSEngine;
  voiceName: string;
  rate: number;
  pitch: number;
  edgeVoice: string;
  dashscopeApiKey: string;
  dashscopeVoice: string;
}
```

主要问题：

- `browser` 对桌面端和移动端都不准确
- `voiceName` 是纯字符串，无法表达 voice 的语言、质量、来源、可用状态
- 移动端和桌面端都没有统一的“系统语音枚举服务”
- UI 目前是以引擎实现细节驱动，不是以产品语义驱动

## 五、目标架构

### 1. 引擎模型

将 TTS 引擎统一为：

```ts
export type TTSEngine = "system" | "edge" | "dashscope";
```

说明：

- `system`：设备内置系统语音
- `edge`：Microsoft Edge 云端神经语音
- `dashscope`：阿里云语音

迁移规则：

- 历史配置中的 `browser` 统一迁移为 `system`

### 2. 系统语音统一数据结构

新增共享类型：

```ts
export type TTSVoiceProvider = "system" | "edge" | "dashscope";
export type TTSVoiceQuality = "default" | "enhanced" | "premium" | "neural" | "unknown";
export type TTSVoicePlatform = "macos" | "windows" | "linux" | "ios" | "android" | "unknown";

export interface TTSVoiceDescriptor {
  id: string;
  provider: TTSVoiceProvider;
  platform: TTSVoicePlatform;
  name: string;
  locale: string;
  language: string;
  quality: TTSVoiceQuality;
  gender?: "male" | "female" | "neutral" | "unknown";
  installed: boolean;
  offlineAvailable: boolean;
  requiresDownload?: boolean;
  isDefault?: boolean;
  rawName?: string;
}
```

设计原则：

- `id` 是配置持久化的主键
- `locale` 和 `language` 用于筛选和匹配
- `quality` 不要求所有平台都能精确识别，但要允许表达 richer metadata
- `rawName` 用于兼容平台原始 voice label

### 3. 统一系统语音能力接口

新增平台能力抽象：

```ts
export interface ISystemVoiceService {
  listVoices(): Promise<TTSVoiceDescriptor[]>;
  getCapabilities(): Promise<{
    canPause: boolean;
    canResume: boolean;
    supportsRate: boolean;
    supportsPitch: boolean;
    supportsVoiceSelection: boolean;
  }>;
}
```

说明：

- **voice 枚举** 与 **语音播放** 分开建模
- 能力检测必须显式化，尤其是 Android / Linux
- UI 和 store 不再直接依赖底层 API 细节

### 4. 播放器架构

当前 `ITTSPlayer` 保持不变，但增加新的系统语音播放器实现：

- 桌面端：`TauriSystemTTSPlayer`
- 移动端：`ExpoSystemTTSPlayer`

其中：

- `EdgeTTSPlayer` 和 `DashScopeTTSPlayer` 保持现状
- 当前的 `BrowserTTSPlayer` 逐步退役，仅作为过渡或 Web fallback

## 六、平台实现方案

### 1. Tauri 桌面端

### 推荐方案

在 `packages/app/src-tauri` 中新增系统语音命令层，底层使用 Rust `tts` crate。

建议新增命令：

```rust
#[tauri::command]
async fn tts_list_system_voices() -> Result<Vec<SystemVoiceDto>, String>;

#[tauri::command]
async fn tts_speak_system(req: SpeakSystemTtsRequest) -> Result<(), String>;

#[tauri::command]
async fn tts_pause_system() -> Result<(), String>;

#[tauri::command]
async fn tts_resume_system() -> Result<(), String>;

#[tauri::command]
async fn tts_stop_system() -> Result<(), String>;

#[tauri::command]
async fn tts_get_system_capabilities() -> Result<SystemTtsCapabilitiesDto, String>;
```

建议同时通过事件向前端回传状态：

- `tts://state`
- `tts://chunk-start`
- `tts://utterance-end`
- `tts://error`

### 为什么不用浏览器 `speechSynthesis`

- 无法稳定获得统一 voice metadata
- 在不同 WebView / 不同系统上的行为差异较大
- 不利于控制 pause/resume/stop 与事件同步
- 长期会让桌面端系统语音与移动端系统语音走成两套产品模型

### 为什么不优先选 `tauri-plugin-tts`

- 可以作为备选或调研分支
- 但第一阶段我们更希望核心控制权掌握在自己手里
- 当前项目已经有较复杂的 TTS store、歌词同步、高亮和跨书状态，自己定义 Tauri 命令更容易对齐现有状态机

### 2. Expo 移动端

### 推荐方案

保留 `expo-speech`，新增系统语音服务层：

- `ExpoSystemVoiceService`
- `ExpoSystemTTSPlayer`

它们分别负责：

- 调用 `Speech.getAvailableVoicesAsync()` 枚举系统语音
- 将平台原始 voice 数据映射成 `TTSVoiceDescriptor`
- 使用 `Speech.speak(..., { voice, language, rate, pitch })` 播放

### Android 特殊处理

需要明确记录以下现实：

- 不同设备的 `voice.id` 与 `voice.name` 不稳定
- 某些设备上 pause / resume 能力有限
- 某些设备系统虽然有 TTS，但语音数据并不完整

因此移动端系统语音策略应当是：

- **能枚举就枚举**
- **能选 voice 就选**
- **选不到时按 locale 回退**
- **再不行就回退到系统默认 voice**

### 第二阶段增强

如果后续安卓系统语音体验依然不理想，再单独评估：

- `react-native-tts`

适合解决的问题：

- 枚举 Android TTS engines
- 提示安装 voice data
- 切换默认 TTS engine

不建议第一阶段就切它，原因是当前我们更需要统一模型，而不是引入新的原生复杂度。

## 七、配置模型调整

建议将 `TTSConfig` 调整为：

```ts
export interface TTSConfig {
  engine: TTSEngine;

  // system
  systemVoiceId: string;
  systemVoiceName: string;
  systemVoiceLocale: string;

  // common
  rate: number;
  pitch: number;

  // edge
  edgeVoice: string;

  // dashscope
  dashscopeApiKey: string;
  dashscopeVoice: string;
}
```

迁移策略：

- 旧配置：
  - `engine === "browser"` -> `engine = "system"`
  - `voiceName` -> 尝试映射为 `systemVoiceId`
- 若映射失败：
  - 清空 `systemVoiceId`
  - 使用系统默认 voice

## 八、UI 方案

## 1. 引擎选择

将所有 TTS UI 统一为三类：

- `系统语音`
- `Edge`
- `DashScope`

不再向用户暴露 `browser` 这个实现词。

## 2. 系统语音选择器

建议展示维度：

- 语音名称
- 语言 / locale
- 质量标签
- 是否系统默认
- 是否已安装 / 是否需要下载

推荐交互：

- 默认先按当前书籍语言过滤
- 提供“全部语音”切换
- 支持试听
- 对当前已选语音显示勾选状态

## 3. 标签设计

建议标签：

- `系统默认`
- `高质量`
- `Premium`
- `需下载`
- `仅本机`

注意：

- 不要假设所有平台都能识别 `premium`
- 标签体系必须允许“信息缺失但还能展示”

## 九、建议改动文件

### Core

- `packages/core/src/tts/types.ts`
- `packages/core/src/tts/display.ts`
- `packages/core/src/stores/tts-store.ts`

### Desktop App

- `packages/app/src/lib/tts/tts-service.ts`
- `packages/app/src/lib/platform/` 下新增 Tauri 系统语音服务
- `packages/app/src/components/reader/TTSControls.tsx`
- `packages/app/src/components/reader/TTSPage.tsx`
- `packages/app/src/components/reader/FooterBar.tsx`
- `packages/app/src-tauri/src/` 下新增 TTS command 与事件桥

### Expo App

- `packages/app-expo/src/lib/platform/expo-speech-player.ts`
- `packages/app-expo/src/lib/platform/rn-tts-factories.ts`
- `packages/app-expo/src/screens/settings/TTSSettingsScreen.tsx`
- `packages/app-expo/src/components/reader/TTSPage.tsx`
- `packages/app-expo/src/stores/tts-store.ts`

## 十、实施阶段

### Phase 1：统一模型与配置迁移

目标：

- 把 `browser` 升级为 `system`
- 新增 `TTSVoiceDescriptor`
- 完成 `TTSConfig` 迁移
- UI 上完成“系统语音”命名替换

产出：

- 类型层完成统一
- 现有桌面 / 移动端不需要一次性全部重写

### Phase 2：Expo 系统语音补强

目标：

- 为 `expo-speech` 增加 voice 枚举和 metadata 映射
- 在移动端提供可用的系统语音选择器

产出：

- iOS / Android 系统语音能力显式化
- 选择和回退逻辑稳定

### Phase 3：Tauri 原生系统语音接入

目标：

- 新增 Tauri Rust 系统语音命令
- 实现 `TauriSystemTTSPlayer`
- 桌面端不再依赖浏览器 `speechSynthesis` 作为主实现

产出：

- macOS / Windows / Linux 的桌面系统语音形成统一入口

### Phase 4：Android 进阶能力评估

目标：

- 评估是否引入 `react-native-tts`
- 仅在 `expo-speech` 无法满足需求时推进

产出：

- 明确 Android 是否需要“engine 层能力”

## 十一、风险与回退

### 1. Linux 语音质量差异大

风险：

- 有的设备能播但声音很差
- 有的设备根本没有可用 voice

策略：

- 让 `system` 语音能力暴露 availability
- UI 上允许明确回退到 `Edge` / `DashScope`

### 2. 系统 voice ID 不稳定

风险：

- OS 更新后某些 voice ID 可能变化

策略：

- 持久化 `id + locale + name`
- 恢复时优先按 `id`，失败再按 `locale + name` 模糊匹配

### 3. Android 能力不完整

风险：

- pause / resume、voice data 安装等行为不一致

策略：

- 通过 `capabilities` 显式上报
- UI 和 store 避免假设所有平台能力相同

### 4. Tauri 原生命令状态同步复杂

风险：

- 当前项目已有歌词同步、高亮、连续朗读、跨书状态

策略：

- Tauri 原生命令层只做“系统语音能力”
- 播放状态机仍以现有 TS store 为核心

## 十二、最终建议

按当前项目现状，推荐路线是：

1. 先完成 **配置与命名统一**，把 `browser` 正式改成 `system`
2. 先补强 **Expo `expo-speech`**，把移动端系统语音做完整
3. 再做 **Tauri 原生系统语音接入**
4. Linux 先接受“可用但不保证高质量”的现实
5. Android 原生增强放到后续评估，不与第一阶段绑定

这样做的好处是：

- 风险最低
- 与现有架构最兼容
- 能尽快把“系统语音”从实现细节提升成真正的产品能力

## 参考资料

- Expo Speech: https://docs.expo.dev/versions/latest/sdk/speech/
- react-native-tts: https://github.com/ak1394/react-native-tts
- Rust tts crate: https://docs.rs/tts
- tauri-plugin-tts: https://docs.rs/tauri-plugin-tts
- Apple AVSpeechSynthesizer: https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer/
- Android TextToSpeech: https://developer.android.com/reference/android/speech/tts/TextToSpeech
- Windows SpeechSynthesizer.AllVoices: https://learn.microsoft.com/uwp/api/windows.media.speechsynthesis.speechsynthesizer.allvoices
- Speech Dispatcher: https://freebsoft.org/speechd/
- eSpeak NG: https://github.com/espeak-ng/espeak-ng
