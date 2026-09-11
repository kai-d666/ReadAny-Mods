/** ZlibDriver 测试 — 2026-09-08 协议对齐(koplugin 规格:rpc.php Cookie 登录/镜像发现/签名直链) */
import { describe, expect, it } from "vitest";
import { ZlibDriver } from "./zlib";
import type { Fetcher } from "./fetcher";

const LOGIN_OK = JSON.stringify({
  errors: [],
  response: { user_id: 12345, user_key: "key123", name: "tester" },
});
const LOGIN_BAD = JSON.stringify({
  errors: [],
  response: { validationError: true, message: "Incorrect email or password" },
});
const SEARCH_OK = JSON.stringify({
  success: 1,
  books: [
    {
      id: 101,
      hash: "abcd1234",
      name: "Dune",
      author: { name: "Frank Herbert" },
      extension: "epub",
      year: 1965,
      language: "en",
      href: "/book/101/abcd1234",
      description: "A desert planet epic.",
      publisher: "Ace",
      pages: 412,
      filesize: 1234567,
    },
    {
      id: 102,
      hash: "efef5678",
      title: "Foundation",
      author: "Isaac Asimov",
      extension: "pdf",
    },
  ],
});
const DOWNLOAD_LINK = "https://cdn.zlib.example/dl/signed?token=xyz";
const EPUB_BYTES = () => new TextEncoder().encode("PK-zlib-epub-body-" + "x".repeat(60));
const CHALLENGE_HTML = "<html><body>DiamWall: Verifying your browser, please wait...</body></html>";
const POPULAR_OK = JSON.stringify({
  success: 1,
  books: [
    { id: 201, hash: "pop1", name: "Popular One", author: { name: "A" }, extension: "epub" },
    { id: 202, hash: "pop2", name: "Popular Two", author: { name: "B" }, extension: "pdf" },
    // 残条:无 extension(最热列表真实形态)→ 走 detailHref 详情补全
    { id: 203, hash: "stub01", name: "Stub Book", author: { name: "C" }, cover: "https://cdn.example/stub.jpg" },
  ],
});
const DETAIL_OK = JSON.stringify({
  success: 1,
  book: {
    id: 203,
    hash: "stub01",
    name: "Stub Book",
    extension: "epub",
    description: "Stub desc",
    publisher: "P",
    pages: 222,
    filesize: 333,
    language: "en",
  },
});
const SIMILAR_OK = JSON.stringify({
  success: 1,
  books: [
    { id: 301, hash: "sim1", name: "Dune Messiah", author: { name: "Frank Herbert" }, extension: "epub" },
  ],
});
const COMMENTS_OK = JSON.stringify({
  success: 1,
  comments: [
    { id: 1, user: { name: "Alice", isPremium: true }, dateRelative: "2 days ago", text: "Great book" },
    { id: 2, user: { name: "Bob" }, text: "Loved it" },
  ],
});

interface Call {
  method: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * 按 pathname 分流:rpc.php 登录 → info/ok 健康检查 → singlelogin 域清单 → search
 * → /file 签名解析 → 直链下载;headers 全量记录供 Cookie/Referer 断言。
 */
function installZlibMock(overrides: {
  login?: () => Response;
  health?: (url: string) => Response;
  search?: () => Response;
  popular?: () => Response;
  file?: () => Response;
  downloadLink?: () => Response;
} = {}) {
  const calls: Call[] = [];
  const fetchImpl: Fetcher = async (url, init) => {
    const u = new URL(url);
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      body: init?.body,
      headers: init?.headers as Record<string, string> | undefined,
      timeoutMs: init?.timeoutMs,
    };
    calls.push(call);
    const path = u.pathname;
    if (path.endsWith("/rpc.php")) return overrides.login ? overrides.login() : new Response(LOGIN_OK, { status: 200 });
    if (path.endsWith("/eapi/info/ok")) {
      return overrides.health ? overrides.health(url) : new Response('{"success":1}', { status: 200 });
    }
    if (path.endsWith("/eapi/info/domains/singlelogin")) {
      return new Response(JSON.stringify({ success: 1, domains: [{ domain: "extra1.example" }] }), { status: 200 });
    }
    if (path.endsWith("/eapi/book/most-popular")) {
      return overrides.popular ? overrides.popular() : new Response(POPULAR_OK, { status: 200 });
    }
    if (path.endsWith("/eapi/book/search")) {
      return overrides.search ? overrides.search() : new Response(SEARCH_OK, { status: 200 });
    }
    if (path.endsWith("/eapi/book/203/stub01")) {
      return new Response(DETAIL_OK, { status: 200 });
    }
    if (path.endsWith("/eapi/book/101/abcd1234/similar")) {
      return new Response(SIMILAR_OK, { status: 200 });
    }
    if (path.startsWith("/papi/comments/book/101")) {
      return new Response(COMMENTS_OK, { status: 200 });
    }
    if (path.endsWith("/eapi/book/101/abcd1234/file")) {
      return overrides.file
        ? overrides.file()
        : new Response(JSON.stringify({ success: 1, file: { downloadLink: DOWNLOAD_LINK, allowDownload: true } }), {
            status: 200,
          });
    }
    if (url.startsWith(DOWNLOAD_LINK)) {
      return overrides.downloadLink ? overrides.downloadLink() : new Response(EPUB_BYTES(), { status: 200 });
    }
    return new Response("<html>404</html>", { status: 404 });
  };
  return { fetchImpl, calls };
}

function makeDriver(overrides: Partial<ConstructorParameters<typeof ZlibDriver>[0]> = {}) {
  return new ZlibDriver({
    domain: "mirror.example",
    username: "me@example.com",
    password: "pw",
    ...overrides,
  });
}

describe("ZlibDriver", () => {
  it("searches anonymously (no forced login), then carries the session after a download logs in", async () => {
    const { fetchImpl, calls } = installZlibMock();
    const driver = makeDriver();
    const feed = await driver.search("dune", undefined, fetchImpl);

    expect(feed.title).toBe("Z-Library · dune");
    expect(feed.publications).toHaveLength(2);
    const acquisition = feed.publications[0].acquisitions[0];
    expect(acquisition.href).toContain("id=101");
    expect(acquisition.href).toContain("hash=abcd1234");
    expect(acquisition.href).toContain("extension=epub");
    // referer 用的 book.href 也随 acquisition 参数传递(绝对化)
    expect(acquisition.href).toContain(encodeURIComponent("https://mirror.example/book/101/abcd1234"));

    // 免登录可搜(koplugin 同款):不触发 rpc.php、不带 Cookie —— 省一次登录往返
    expect(calls.some((c) => new URL(c.url).pathname === "/rpc.php")).toBe(false);
    expect(calls.some((c) => c.url.includes("/eapi/user/login"))).toBe(false); // 弃用端点绝不调用
    const anonSearch = calls.find((c) => c.url.includes("/eapi/book/search"))!;
    expect(anonSearch.headers?.Cookie).toBeUndefined();
    expect(anonSearch.body).toContain("message=dune");
    // 详情字段透传(详情页展示:简介/出版社/页数/体积)
    expect(feed.publications[0].summary).toBe("A desert planet epic.");
    expect(feed.publications[0].publisher).toBe("Ace");
    expect(feed.publications[0].extent).toBe("412");
    expect(feed.publications[0].acquisitions[0].size).toBe(1234567);

    // 下载链路登录;此后的搜索自动携带会话 Cookie
    await driver.download(
      { id: "101", hash: "abcd1234", extension: "epub", href: "/book/101/abcd1234" },
      fetchImpl,
    );
    expect(calls.some((c) => new URL(c.url).pathname === "/rpc.php")).toBe(true);
    const before = calls.length;
    await driver.search("dune", undefined, fetchImpl);
    const authedSearch = calls.slice(before).find((c) => c.url.includes("/eapi/book/search"))!;
    expect(authedSearch.headers?.Cookie).toBe("remix_userid=12345; remix_userkey=key123");
  });

  it("throws a readable error when rpc.php rejects credentials (download logs in)", async () => {
    const { fetchImpl } = installZlibMock({ login: () => new Response(LOGIN_BAD, { status: 200 }) });
    await expect(
      makeDriver().download({ id: "101", hash: "abcd1234", extension: "epub" }, fetchImpl),
    ).rejects.toThrow(/账号或密码错误/);
  });

  it("moves to the next mirror when the configured one serves a DiamWall challenge", async () => {
    const { fetchImpl, calls } = installZlibMock({
      health: (url) => {
        // 仅 article.sk 健康(确定性):配置域被挑战、其余种子域封锁 → 必须自动换到 article.sk
        if (url.includes("mirror.example")) return new Response(CHALLENGE_HTML, { status: 307 });
        if (url.includes("article.sk")) return new Response('{"success":1}', { status: 200 });
        return new Response(CHALLENGE_HTML, { status: 513 });
      },
    });
    const driver = makeDriver();
    const feed = await driver.search("dune", undefined, fetchImpl);
    expect(feed.publications).toHaveLength(2);
    const searchCalls = calls.filter((c) => c.url.includes("/eapi/book/search"));
    expect(new URL(searchCalls[0].url).hostname).toBe("article.sk");
  });

  it("throws a no-mirror error when every candidate is blocked", async () => {
    const { fetchImpl } = installZlibMock({
      health: () => new Response(CHALLENGE_HTML, { status: 513 }),
    });
    await expect(makeDriver().search("dune", undefined, fetchImpl)).rejects.toThrow(/没有可用的 Z-Library 镜像/);
  });

  it("resolves a signed link via /file then downloads with Cookie and Referer", async () => {
    const { fetchImpl, calls } = installZlibMock();
    const driver = makeDriver();
    const bytes = await driver.download(
      { id: "101", hash: "abcd1234", extension: "epub", href: "/book/101/abcd1234" },
      fetchImpl,
    );
    expect(new TextDecoder().decode(bytes)).toContain("PK-zlib-epub-body");

    const pathnameOf = (c: Call) => new URL(c.url).pathname;
    expect(calls.some((c) => pathnameOf(c) === "/eapi/book/101/abcd1234/file")).toBe(true);
    const direct = calls.find((c) => c.url.startsWith(DOWNLOAD_LINK))!;
    expect(direct.headers?.Referer).toBe("https://mirror.example/book/101/abcd1234");
    expect(direct.headers?.Cookie).toBe("remix_userid=12345; remix_userkey=key123");
    // 大文件下载必须用长超时(默认 15s 会掐断 >10MB 的书)
    expect(direct.timeoutMs).toBe(300_000);
  });

  it("rejects a quota-limited download with a readable message", async () => {
    const { fetchImpl } = installZlibMock({
      file: () =>
        new Response(
          JSON.stringify({
            success: 1,
            file: { allowDownload: false, message: "Download limit reached. Try again later." },
          }),
          { status: 200 },
        ),
    });
    await expect(
      makeDriver().download({ id: "101", hash: "abcd1234", extension: "epub" }, fetchImpl),
    ).rejects.toThrow(/额度已达上限/);
  });

  it("rejects non-book download payloads (magic validation)", async () => {
    const { fetchImpl } = installZlibMock({
      downloadLink: () => new Response("<html>waiting</html>", { status: 200 }),
    });
    await expect(
      makeDriver().download({ id: "101", hash: "abcd1234", extension: "epub" }, fetchImpl),
    ).rejects.toThrow(/不是有效书文件/);
  });

  it("parses large search responses (>4KB) without truncation", async () => {
    // 30 本书 ≈ 5KB+ 的搜索响应:responseText 曾被截断到 4096 字节导致 JSON.parse 崩(真机复现的坑)
    const bigBooks = Array.from({ length: 30 }, (_, i) => ({
      id: 200 + i,
      hash: `hash${String(i).padStart(6, "0")}`,
      name: `Book number ${i} with a fairly long title to bloat the payload`,
      author: { name: `Author ${i}` },
      extension: "epub",
    }));
    const bigSearch = JSON.stringify({ success: 1, books: bigBooks });
    expect(bigSearch.length).toBeGreaterThan(4096);

    const { fetchImpl } = installZlibMock({
      search: () => new Response(bigSearch, { status: 200 }),
    });
    const feed = await makeDriver().search("dune", undefined, fetchImpl);
    expect(feed.publications).toHaveLength(30);
  });

  it("passes order/language/format filters to the search form and emits facets", async () => {
    const { fetchImpl, calls } = installZlibMock();
    const driver = makeDriver();
    const feed = await driver.search(
      "dune",
      { order: "popular", lang: "english", ext: "epub" },
      fetchImpl,
    );

    const searchCall = calls.find((c) => c.url.includes("/eapi/book/search"))!;
    expect(searchCall.body).toContain("order=popular");
    expect(searchCall.body).toContain("languages%5B0%5D=english"); // koplugin 表单:languages[0]
    expect(searchCall.body).toContain("extensions%5B0%5D=epub");

    const facets = feed.facets ?? [];
    expect(new Set(facets.map((f) => f.group))).toEqual(new Set(["order", "language", "format"]));
    // 全量对齐 koplugin:排序 8 / 格式 12(+全部) / 语言 191(+全部)
    expect(facets.filter((f) => f.group === "order")).toHaveLength(8);
    expect(facets.filter((f) => f.group === "format")).toHaveLength(13);
    expect(facets.filter((f) => f.group === "language").length).toBeGreaterThan(100);
    const hottest = facets.find((f) => f.group === "order" && f.title === "最热")!;
    expect(hottest.active).toBe(true);
    const english = facets.find((f) => f.group === "language" && f.title === "英文")!;
    expect(english.active).toBe(true);
    expect(english.href).toContain("lang=english");
    expect(english.href).toContain("order=popular"); // 切换语言保留其它参数
    expect(english.href).toContain("q=dune");
  });

  it("browses most-popular books on entry with pre-search facets (no query)", async () => {
    const { fetchImpl, calls } = installZlibMock();
    const feed = await makeDriver().browse(undefined, fetchImpl);
    expect(feed.publications).toHaveLength(3);
    expect(feed.title).toContain("热门");
    // 残条(无 extension):不发下载项,发 detailHref(客户端点开时补全;修复"书籍被当目录"根因)
    const stub = feed.publications[2];
    expect(stub.acquisitions).toHaveLength(0);
    expect(stub.detailHref).toContain("/opds/zlib/detail?id=203&hash=stub01");
    expect(calls.some((c) => new URL(c.url).pathname === "/eapi/book/most-popular")).toBe(true);
    // 搜索前即可配置:入口 feed 带全量分面,href 指回入口(带参,无 q)
    const facets = feed.facets ?? [];
    expect(facets.filter((f) => f.group === "order" && f.active).map((f) => f.title)).toEqual(["最热"]);
    const english = facets.find((f) => f.group === "language" && f.title === "英文")!;
    expect(english.href).toContain("/opds/zlib/?");
    expect(english.href).not.toContain("q=");
    expect(english.href).toContain("lang=english");
  });

  it("fetches similar books as a feed and comments as items (koplugin parity)", async () => {
    const { fetchImpl, calls } = installZlibMock();
    const driver = makeDriver();

    const similar = await driver.similar("101", "abcd1234", fetchImpl);
    expect(similar.publications).toHaveLength(1);
    expect(similar.publications[0].title).toBe("Dune Messiah");

    const comments = await driver.comments("101", fetchImpl);
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({
      user: "Alice",
      premium: true,
      date: "2 days ago",
      text: "Great book",
    });
    expect(comments[1].user).toBe("Bob");

    expect(
      calls.some((c) => new URL(c.url).pathname === "/eapi/book/101/abcd1234/similar"),
    ).toBe(true);
    expect(calls.some((c) => new URL(c.url).pathname.startsWith("/papi/comments/book/101"))).toBe(
      true,
    );
  });

  it("resolves details for stub list entries (koplugin fetchDetailsThenDownload)", async () => {
    const { fetchImpl, calls } = installZlibMock();
    const detail = await makeDriver().detail("203", "stub01", fetchImpl);
    expect(detail.extension).toBe("epub");
    expect(detail.description).toBe("Stub desc");
    expect(detail.publisher).toBe("P");
    expect(detail.pages).toBe(222);
    expect(detail.filesize).toBe(333);
    expect(calls.some((c) => new URL(c.url).pathname === "/eapi/book/203/stub01")).toBe(true);
  });

  it("caches most-popular for 60s (repeated filter taps stay instant)", async () => {
    const { fetchImpl, calls } = installZlibMock();
    const driver = makeDriver();
    await driver.browse(undefined, fetchImpl);
    await driver.browse({ lang: "english" }, fetchImpl);
    await driver.browse({ order: "date", ext: "PDF" }, fetchImpl);
    const popularCalls = calls.filter(
      (c) => new URL(c.url).pathname === "/eapi/book/most-popular",
    );
    expect(popularCalls).toHaveLength(1); // 只发一次上游请求
  });

  it("browse applies preset filters (order/lang/ext) from entry URL", async () => {
    const { fetchImpl } = installZlibMock();
    const feed = await makeDriver().browse({ order: "date", lang: "chinese", ext: "PDF" }, fetchImpl);
    const facets = feed.facets ?? [];
    expect(facets.find((f) => f.group === "order" && f.active)?.title).toBe("最新");
    expect(facets.find((f) => f.group === "language" && f.active)?.title).toBe("中文");
    expect(facets.find((f) => f.group === "format" && f.active)?.title).toBe("PDF");
  });

  it("uses authOverride (专属链接快路径) when no full account — download skips rpc.php and carries the session", async () => {
    const { fetchImpl, calls } = installZlibMock();
    // 邮箱+密码齐全时强制在线登录;专属链接仅在无完整账号时生效
    const driver = makeDriver({ auth: { id: "777", key: "key-of-link" }, password: "" });
    const bytes = await driver.download(
      { id: "101", hash: "abcd1234", extension: "epub", href: "/book/101/abcd1234" },
      fetchImpl,
    );
    expect(new TextDecoder().decode(bytes)).toContain("PK-zlib-epub-body");
    expect(calls.some((c) => new URL(c.url).pathname === "/rpc.php")).toBe(false);
    const fileCall = calls.find((c) => new URL(c.url).pathname.endsWith("/file"))!;
    expect(fileCall.headers?.Cookie).toBe("remix_userid=777; remix_userkey=key-of-link");
  });

  it("re-authenticates once when /file returns 400 Please login", async () => {
    let fileCalls = 0;
    const { fetchImpl, calls } = installZlibMock({
      file: () => {
        fileCalls += 1;
        // 第一次:会话无效;第二次:正常返回签名直链
        if (fileCalls === 1) {
          return new Response(JSON.stringify({ success: 0, error: "Please login" }), { status: 400 });
        }
        return new Response(
          JSON.stringify({ success: 1, file: { downloadLink: DOWNLOAD_LINK, allowDownload: true } }),
          { status: 200 },
        );
      },
    });
    const driver = makeDriver();
    const bytes = await driver.download(
      { id: "101", hash: "abcd1234", extension: "epub", href: "/book/101/abcd1234" },
      fetchImpl,
    );
    expect(new TextDecoder().decode(bytes)).toContain("PK-zlib-epub-body");
    // 第一次 400 后重新走 rpc.php,再二次 /file
    const rpcCalls = calls.filter((c) => new URL(c.url).pathname === "/rpc.php");
    expect(rpcCalls.length).toBeGreaterThanOrEqual(1);
    const fileCallsCount = calls.filter((c) => new URL(c.url).pathname.endsWith("/file")).length;
    expect(fileCallsCount).toBeGreaterThanOrEqual(2);
  });
});
