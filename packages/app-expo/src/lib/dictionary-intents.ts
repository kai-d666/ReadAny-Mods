/**
 * dictionary-intents — 词典接口表(移植静读天下"自定义词典设置"接口模型 + koodo scheme 增量)。
 *
 * 接口 = 固定选项 + 每种固定协议,长按查词走所选接口,由系统解析拉起。
 * 与"枚举系统 App"相反:选项固定出现,不扫描;调用时才要求第三方词典已安装。
 *
 * 铁律:不枚举、不写死"唯一拉欧路"分支。第 1 项(深蓝|欧路|MDict|ColorDict)=
 * 一个隐式协议(colordict.intent.action.SEARCH),四家兼容,谁装系统拉起谁。
 *
 * 协议依据:
 * - 第 1/2/3/4/5/6/7/10 项 ← 静读天下 ActivityTxt 反编译分派(L21469/L21557/L21511/L21521
 *   /arrays.xml dict_list_url + L21579 Customized / DictPackage USE_INTENT_DICT)
 * - 第 8/9 项 ← koodo 安卓逆向报告(词霸 iciba.kingsoft.word://、韦氏 vmw-collegiate://),
 *   未经真机验证;不可用则注释掉该项(TODO 标注)
 */
import * as IntentLauncher from "expo-intent-launcher";

/** 接口分类:显式 intent(写死组件)/ 隐式 intent(系统解析)/ 浏览器 URL / 自定义 URL scheme */
export type DictionaryLaunchKind =
  | "explicit-intent"
  | "implicit-intent"
  | "view-url"
  | "scheme-url";

export interface DictionaryOption {
  /** 持久化标识 */
  key: string;
  /** i18n label key(settings.json) */
  labelKey: string;
  kind: DictionaryLaunchKind;
  /** kind=explicit/intent 时:activity action */
  action?: string;
  /** kind=explicit-intent 时必填 */
  packageName?: string;
  className?: string;
  /** kind=view-url / scheme-url:URL 模板,%s 替换查询词 */
  urlTemplate?: string;
  /** extra 键名(implicit/explicit 传词用):PROCESS_TEXT / EXTRA_QUERY */
  extraKey?: string;
  /** 可选 MIME type(仅接收方 filter 带 mimeType 的接口才设置,照静读天下 setType 结构) */
  type?: string;
}

/** 词典接口表(9 项,顺序即设置页展示顺序) */
export const DICTIONARY_OPTIONS: DictionaryOption[] = [
  // 1. 默认:多词典联动(欧路/深蓝/MDict/ColorDict 谁装拉起谁)
  {
    key: "colordict-group",
    labelKey: "settings.dictionaryOptionGroup",
    kind: "implicit-intent",
    action: "colordict.intent.action.SEARCH",
    // 静读天下源码 L21472: putExtra("EXTRA_QUERY", str2) —— 字符串字面量就是 "EXTRA_QUERY"
    extraKey: "EXTRA_QUERY",
  },
  // 2. 有道
  {
    key: "youdao",
    labelKey: "settings.dictionaryOptionYoudao",
    kind: "explicit-intent",
    action: "android.intent.action.PROCESS_TEXT",
    packageName: "com.youdao.dict",
    className: "com.youdao.dict.activity.ProcessTextActivity",
    extraKey: "android.intent.extra.PROCESS_TEXT",
  },
  // 3. 金山词霸
  {
    key: "iciba",
    labelKey: "settings.dictionaryOptionIciba",
    kind: "explicit-intent",
    // 词霸 com.kingsoft 实际注册:PROCESS_TEXT + SystemCopyMenuActivity + mimeType text/plain
    // (从安装包 dump 确认,与欧路/有道同路径;koodo 的 iciba.kingsoft.word:// scheme 弃用)
    action: "android.intent.action.PROCESS_TEXT",
    packageName: "com.kingsoft",
    className: "com.kingsoft.SystemCopyMenuActivity",
    extraKey: "android.intent.extra.PROCESS_TEXT",
    type: "text/plain", // filter 带 mimeType text/plain → 与静读天下 setType 结构一致
  },
  // 4-6. 海外三大词典(放一起)
  {
    key: "wordweb",
    labelKey: "settings.dictionaryOptionWordWeb",
    kind: "explicit-intent",
    action: "android.intent.action.SEARCH",
    packageName: "com.wordwebsoftware.android.wordweb",
    className: "com.wordwebsoftware.android.wordweb.activity.WordWebActivity",
    // 静读天下源码 L21516: SearchIntents.EXTRA_QUERY("query")
    extraKey: "query",
  },
  {
    key: "oxford",
    labelKey: "settings.dictionaryOptionOxford",
    kind: "explicit-intent",
    action: "android.intent.action.PROCESS_TEXT",
    packageName: "com.mobisystems.msdict.embedded.wireless.oxford.dictionaryofenglish",
    className: "com.mobisystems.base_dict_plugin.text_processing.TextProcessingActivity",
    extraKey: "android.intent.extra.PROCESS_TEXT",
    // 静读天下 L21530: setType("text/plain") —— 仅 oxford 这类 filter 带 mimeType 的才设
    type: "text/plain",
  },
  {
    key: "merriam",
    labelKey: "settings.dictionaryOptionMerriam",
    kind: "explicit-intent",
    // 韦氏官方 com.merriamwebster 实测(dumpsys package filter):
    //   DictionaryActivity 注册 android.intent.action.SEARCH + mw-collegiate:// search:// scheme
    // koodo 报告的 vmw-collegiate:// 不在官方 app —— 弃用 scheme,改走 SEARCH 显式组件最稳(与 wordweb 同路径)
    action: "android.intent.action.SEARCH",
    packageName: "com.merriamwebster",
    className: "com.merriamwebster.dictionary.activity.dictionary.DictionaryActivity",
    extraKey: "query", // SearchIntents.EXTRA_QUERY
  },
  // 7-8. 在线词典(在海外三词典后、自定义前)
  {
    key: "baidu",
    labelKey: "settings.dictionaryOptionBaidu",
    kind: "view-url",
    urlTemplate: "http://dict.baidu.com/s?wd=%s&ie=utf-8",
  },
  {
    key: "haici",
    labelKey: "settings.dictionaryOptionHaiCi",
    kind: "view-url",
    urlTemplate: "http://3g.dict.cn/s.php?q=%s",
  },
  // 9. 自定义在线词典(最后)
  {
    key: "custom",
    labelKey: "settings.dictionaryOptionCustom",
    kind: "view-url",
    urlTemplate: "", // 用户配置;占位,未配置时 buildDictionaryLaunch 返回 null
  },
];

/** 默认接口:colordict 联动(欧路/深蓝/MDict/ColorDict 谁装拉起谁) */
export const DEFAULT_DICTIONARY_KEY = "colordict-group";

export function getDictionaryOption(key: string | undefined): DictionaryOption {
  return (
    DICTIONARY_OPTIONS.find((o) => o.key === key) ??
    DICTIONARY_OPTIONS.find((o) => o.key === DEFAULT_DICTIONARY_KEY)!
  );
}

/**
 * 组装本次拉起的 IntentLauncher 参数(纯函数,可单测)。
 * - implicit-intent:不带 packageName/className(系统解析)
 * - explicit-intent:带组件
 * - view-url/scheme-url:VIEW + data(URL 模板 %s 替换 → encodeURIComponent)
 * - custom 项未配置 URL → 返回 null(调用方提示用户去设置)
 */
export function buildDictionaryLaunch(
  word: string,
  opt: DictionaryOption,
  customUrl?: string,
): { activityAction: string; params: IntentLauncher.IntentLauncherParams } | null {
  const trimmed = (word || "").trim();
  if (!trimmed) return null;

  if (opt.kind === "view-url" || opt.kind === "scheme-url") {
    // custom 项:URL 来自用户配置 dictionaryCustomUrl;未配置 → null
    const template = opt.key === "custom" ? customUrl : opt.urlTemplate;
    if (!template) return null;
    const url = template.includes("%s")
      ? template.replace("%s", encodeURIComponent(trimmed))
      : `${template}${encodeURIComponent(trimmed)}`;
    return {
      activityAction: "android.intent.action.VIEW",
      params: { data: url },
    };
  }

  // explicit / implicit —— 逐项对照静读天下 openDictUrl 结构(不自行加字段):
  // - 隐式(colordict/YunCi 类):action + putExtra,无 type(接收方 filter 无 mimeType)
  // - 显式 PROCESS_TEXT + 接收方 filter 带 mimeType(oxford/dictionray)→ setType(text/plain)
  // - 显式 PROCESS_TEXT 接收方 filter 无 mimeType(youdao)→ 无 type
  // - 显式 SEARCH(wordweb)→ 无 type
  // 类别:隐式 intent 匹配需含 filter category;统一补 category DEFAULT 与系统行为一致。
  const params: IntentLauncher.IntentLauncherParams = {
    category: "android.intent.category.DEFAULT",
    extra: { [opt.extraKey ?? "android.intent.extra.PROCESS_TEXT"]: trimmed },
  };
  if (opt.kind === "explicit-intent") {
    if (opt.packageName && opt.className) {
      params.packageName = opt.packageName;
      params.className = opt.className;
    }
    // 仅接收方 filter 带 mimeType 的(PROCESS_TEXT 词典)才设 type;SEARCH/无 type 的不设
    if (opt.type) params.type = opt.type;
  }
  return { activityAction: opt.action ?? "android.intent.action.PROCESS_TEXT", params };
}

/** 未安装所选词典时抛出的提示错误(labelKey 供调用方 i18n 渲染) */
export class DictionaryNotInstalledError extends Error {
  readonly labelKey: string;
  constructor(labelKey: string) {
    super(`dictionary not installed: ${labelKey}`);
    this.name = "DictionaryNotInstalledError";
    this.labelKey = labelKey;
  }
}

/** 自定义词典 URL 未配置(pure 层不依赖 i18n,由调用方 t 显示) */
export class DictionaryOptionNotConfiguredError extends Error {
  constructor() {
    super("custom dictionary URL not configured");
    this.name = "DictionaryOptionNotConfiguredError";
  }
}

/**
 * 按 key 拉起查词。默认 colordict-group(欧路等系统解析)。
 * - 空词 → undefined(不拉起)
 * - 自定义 URL 未配置 → 抛 DictionaryOptionNotConfiguredError
 * - 词典未安装/无处理器 → 抛 DictionaryNotInstalledError(调用方 Alert)
 */
export async function launchDictionary(
  word: string,
  key: string | undefined,
  customUrl?: string,
): Promise<void> {
  const opt = getDictionaryOption(key ?? DEFAULT_DICTIONARY_KEY);
  const launch = buildDictionaryLaunch(word, opt, customUrl);
  if (!launch) {
    if (opt.key === "custom") throw new DictionaryOptionNotConfiguredError();
    return; // 空词等 → 无操作
  }
  try {
    await IntentLauncher.startActivityAsync(launch.activityAction, launch.params);
  } catch (err) {
    if (
      err instanceof Error &&
      /ActivityNotFound|not found|No Activity|NoActivityFound|no match/i.test(err.message)
    ) {
      throw new DictionaryNotInstalledError(opt.labelKey);
    }
    throw err;
  }
}
