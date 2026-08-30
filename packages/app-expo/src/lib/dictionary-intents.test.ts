import { beforeEach, describe, expect, it, vi } from "vitest";

// node 环境无 react-native / expo-intent-launcher
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
const startActivityAsync = vi.fn();
vi.mock("expo-intent-launcher", () => ({
  startActivityAsync,
}));

const {
  DICTIONARY_OPTIONS,
  DEFAULT_DICTIONARY_KEY,
  buildDictionaryLaunch,
  launchDictionary,
  getDictionaryOption,
  DictionaryNotInstalledError,
  DictionaryOptionNotConfiguredError,
} = await import("./dictionary-intents");

describe("DICTIONARY_OPTIONS — 10 项接口表", () => {
  it("含默认 colordict-group 且为 implicit(不带组件)", () => {
    const opt = getDictionaryOption(undefined);
    expect(opt.key).toBe(DEFAULT_DICTIONARY_KEY);
    expect(opt.kind).toBe("implicit-intent");
    expect(opt.action).toBe("colordict.intent.action.SEARCH");
    expect(opt.packageName).toBeUndefined();
  });
});

describe("buildDictionaryLaunch — 各类组装", () => {
  it("implicit-intent(colordict-group)→ 无组件、无 type(必须),带 category DEFAULT + EXTRA_QUERY", () => {
    const opt = getDictionaryOption(undefined);
    const out = buildDictionaryLaunch("hello", opt)!;
    expect(out.activityAction).toBe("colordict.intent.action.SEARCH");
    expect(out.params.packageName).toBeUndefined();
    expect(out.params.className).toBeUndefined();
    expect(out.params.extra).toEqual({ EXTRA_QUERY: "hello" });
    expect(out.params.type).toBeUndefined(); // 关键:隐式不能带 type(欧路 filter 无 mimeType)
    expect(out.params.category).toBe("android.intent.category.DEFAULT");
  });

  it("explicit-intent(youdao)→ 带组件 + PROCESS_TEXT extra,【无 type】(静读无 setType)", () => {
    const opt = DICTIONARY_OPTIONS.find((o) => o.key === "youdao")!;
    const out = buildDictionaryLaunch("hello", opt)!;
    expect(out.activityAction).toBe("android.intent.action.PROCESS_TEXT");
    expect(out.params.packageName).toBe("com.youdao.dict");
    expect(out.params.className).toBe("com.youdao.dict.activity.ProcessTextActivity");
    expect(out.params.extra).toEqual({ "android.intent.extra.PROCESS_TEXT": "hello" });
    expect(out.params.type).toBeUndefined();
  });

  it("explicit-intent(wordweb)→ ACTION_SEARCH + query extra,无 type", () => {
    const opt = DICTIONARY_OPTIONS.find((o) => o.key === "wordweb")!;
    const out = buildDictionaryLaunch("hello", opt)!;
    expect(out.activityAction).toBe("android.intent.action.SEARCH");
    expect(out.params.extra).toEqual({ query: "hello" });
    expect(out.params.type).toBeUndefined();
  });

  it("explicit-intent(oxford)→ PROCESS_TEXT + 组件 + 【有 type text/plain】", () => {
    const opt = DICTIONARY_OPTIONS.find((o) => o.key === "oxford")!;
    const out = buildDictionaryLaunch("hello", opt)!;
    expect(out.params.type).toBe("text/plain");
    expect(out.params.extra).toEqual({ "android.intent.extra.PROCESS_TEXT": "hello" });
  });

  it("view-url(baidu)→ VIEW + URL 模板替换 %s(encodeURIComponent)", () => {
    const opt = DICTIONARY_OPTIONS.find((o) => o.key === "baidu")!;
    const out = buildDictionaryLaunch("hello world", opt)!;
    expect(out.activityAction).toBe("android.intent.action.VIEW");
    expect(out.params.data).toBe("http://dict.baidu.com/s?wd=hello%20world&ie=utf-8");
  });

  it("explicit-intent(iciba/词霸)→ PROCESS_TEXT + SystemCopyMenuActivity + type", () => {
    const opt = DICTIONARY_OPTIONS.find((o) => o.key === "iciba")!;
    const out = buildDictionaryLaunch("hello", opt)!;
    expect(out.activityAction).toBe("android.intent.action.PROCESS_TEXT");
    expect(out.params.packageName).toBe("com.kingsoft");
    expect(out.params.className).toBe("com.kingsoft.SystemCopyMenuActivity");
    expect(out.params.extra).toEqual({ "android.intent.extra.PROCESS_TEXT": "hello" });
    expect(out.params.type).toBe("text/plain");
  });

  it("explicit-intent(merriam/韦氏)→ SEARCH + DictionaryActivity + query extra,无 type", () => {
    const opt = DICTIONARY_OPTIONS.find((o) => o.key === "merriam")!;
    const out = buildDictionaryLaunch("hello", opt)!;
    expect(out.activityAction).toBe("android.intent.action.SEARCH");
    expect(out.params.packageName).toBe("com.merriamwebster");
    expect(out.params.className).toBe(
      "com.merriamwebster.dictionary.activity.dictionary.DictionaryActivity",
    );
    expect(out.params.extra).toEqual({ query: "hello" });
    expect(out.params.type).toBeUndefined();
  });

  it("custom 未配置 → null", () => {
    const opt = DICTIONARY_OPTIONS.find((o) => o.key === "custom")!;
    expect(buildDictionaryLaunch("hello", opt)).toBeNull();
  });

  it("空词 → null", () => {
    const opt = getDictionaryOption(undefined);
    expect(buildDictionaryLaunch("   ", opt)).toBeNull();
  });
});

describe("launchDictionary — 拉起与错误", () => {
  beforeEach(() => {
    startActivityAsync.mockReset();
    startActivityAsync.mockResolvedValue(undefined as never);
  });

  it("按 key 发起 startActivityAsync", async () => {
    await launchDictionary("hello", "baidu");
    expect(startActivityAsync).toHaveBeenCalledWith("android.intent.action.VIEW", {
      data: "http://dict.baidu.com/s?wd=hello&ie=utf-8",
    });
  });

  it("custom 未配置 → 抛 DictionaryOptionNotConfiguredError", async () => {
    await expect(launchDictionary("hello", "custom")).rejects.toBeInstanceOf(
      DictionaryOptionNotConfiguredError,
    );
  });

  it("ActivityNotFound → 抛 DictionaryNotInstalledError(带 labelKey)", async () => {
    startActivityAsync.mockRejectedValueOnce(new Error("No Activity found to handle Intent"));
    await expect(launchDictionary("hello", "youdao")).rejects.toBeInstanceOf(
      DictionaryNotInstalledError,
    );
  });

  it("非 ActivityNotFound 错误原样抛出", async () => {
    startActivityAsync.mockRejectedValueOnce(new Error("network error"));
    await expect(launchDictionary("hello", "youdao")).rejects.toThrow("network error");
  });
});
