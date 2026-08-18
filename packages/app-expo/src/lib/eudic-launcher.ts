/**
 * eudic-launcher — 唤起欧路词典(Eudic)小窗查词/翻译。
 *
 * 机制(安卓成熟方案,参考静读天下 + 欧路配合):
 * - ACTION_PROCESS_TEXT 是安卓 6.0+ 标准文本处理 intent
 * - 欧路显式注册了 LightpeekActivity(划词小窗),对单词显示词义、对长句走整句翻译
 * - 显式指定 packageName + className 直达小窗,不经过系统选择器
 *
 * 无需 <queries> 声明:显式组件启动不依赖包可见性(仅查询已装应用时需要)。
 * 需要真机/模拟器装有欧路词典(com.eusoft.eudic)。
 */
import * as IntentLauncher from "expo-intent-launcher";

const EUDIC_PACKAGE = "com.eusoft.eudic";
const EUDIC_LIGHTPEEK_ACTIVITY = "com.eusoft.dict.activity.dict.LightpeekActivity";
const ACTION_PROCESS_TEXT = "android.intent.action.PROCESS_TEXT";
const EXTRA_PROCESS_TEXT = "android.intent.extra.PROCESS_TEXT";

export class EudicNotInstalledError extends Error {
  constructor() {
    super("未检测到欧路词典,请先安装后再使用划词查词");
    this.name = "EudicNotInstalledError";
  }
}

/**
 * 把文本(单词或长句)送入欧路划词小窗。
 * 短词 → 词典释义;长句 → 欧路整句翻译(由欧路自行判定)。
 */
export async function launchEudic(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  try {
    await IntentLauncher.startActivityAsync(ACTION_PROCESS_TEXT, {
      type: "text/plain",
      packageName: EUDIC_PACKAGE,
      className: EUDIC_LIGHTPEEK_ACTIVITY,
      extra: { [EXTRA_PROCESS_TEXT]: trimmed },
    });
  } catch (err) {
    // startActivity 抛 ActivityNotFoundException 时通常 = 未安装或组件不存在
    if (err instanceof Error && /ActivityNotFound|not found|No Activity/i.test(err.message)) {
      throw new EudicNotInstalledError();
    }
    throw err;
  }
}
