import { describe, expect, it } from "vitest";
import { htmlToPlainText } from "./html-text";

describe("htmlToPlainText", () => {
  it("剥掉 ZL 式段落标签并保留段落", () => {
    const raw = "<p>第一段。</p><p>第二段。</p>";
    expect(htmlToPlainText(raw)).toBe("第一段。\n第二段。");
  });

  it("<br> 转换行,<br><br> 视作段落断(空行最多留一个)", () => {
    expect(htmlToPlainText("a<br>b")).toBe("a\nb");
    expect(htmlToPlainText("a<br><br>b")).toBe("a\n\nb");
    expect(htmlToPlainText("a<br><br><br><br>b")).toBe("a\n\nb");
    expect(htmlToPlainText("<p>a</p><p></p><p></p><p>b</p>")).toBe("a\n\nb");
  });

  it("解命名实体与数字实体(&#39; / &#x27; / &amp; / &nbsp;)", () => {
    expect(htmlToPlainText("Tom&#39;s &amp; Jerry&#x27;s")).toBe("Tom's & Jerry's");
    expect(htmlToPlainText("a&nbsp;b&hellip;c")).toBe("a b…c");
  });

  it("纯文本(含 < > 但不构成标签)原样返回", () => {
    expect(htmlToPlainText("5 < 10 and 3 > 2")).toBe("5 < 10 and 3 > 2");
    // 含实体但无标签:只解实体
    expect(htmlToPlainText("A &amp; B")).toBe("A & B");
  });

  it("空值/纯空白 → undefined", () => {
    expect(htmlToPlainText("")).toBeUndefined();
    expect(htmlToPlainText("   \n  ")).toBeUndefined();
    expect(htmlToPlainText(undefined)).toBeUndefined();
    expect(htmlToPlainText(null)).toBeUndefined();
  });

  it("非法码点不炸,原样保留", () => {
    expect(htmlToPlainText("x&#999999999;y")).toBe("x&#999999999;y");
  });

  it("真实 ZL 简介:无残留标签、段落可读", () => {
    const raw =
      "<p>A lone astronaut must save the earth from disaster.</p><p>Ryland Grace is the sole survivor&nbsp;on a desperate mission.</p><p>&nbsp;</p><p>Part scientific mystery, part journey&hellip;</p>";
    const out = htmlToPlainText(raw) ?? "";
    expect(out).not.toContain("<");
    expect(out).not.toContain("&");
    expect(out.split("\n").filter(Boolean)).toHaveLength(3);
    expect(out).toContain("scientific mystery");
  });
});
