import { describe, expect, it } from "vitest";

import type { Fetcher } from "./fetcher";
import { ZlibDriver } from "./zlib";

const LOGIN_OK = JSON.stringify({
  success: true,
  user_profile: { id: 12345, remix_userkey: "key123", name: "tester" },
});

const SEARCH_OK = JSON.stringify({
  success: true,
  books: [
    {
      id: 101,
      hash: "abcd1234",
      name: "Dune",
      author: { name: "Frank Herbert" },
      extension: "epub",
      year: 1965,
      language: "en",
    },
    {
      id: 102,
      hash: "efef5678",
      title: "Foundation",
      author: "Isaac Asimov",
      extension: "pdf",
      year: 1951,
    },
  ],
});

/** 按 URL/body 分流:login → search → download */
function installZlibMock() {
  const calls: string[] = [];
  const fetchImpl: Fetcher = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url.split("?")[0].split("/").pop()} ${init?.body ?? ""}`);
    const path = new URL(url).pathname;
    if (path.endsWith("/eapi/user/login")) {
      return new Response(LOGIN_OK, { status: 200 });
    }
    if (path.endsWith("/eapi/book/search")) {
      return new Response(SEARCH_OK, { status: 200 });
    }
    if (path.includes("/eapi/book/101/abcd1234")) {
      return new Response(new TextEncoder().encode("PK-zlib-epub-body-" + "x".repeat(60)), { status: 200 });
    }
    return new Response("<html>404</html>", { status: 404 });
  };
  return { fetchImpl, calls };
}

describe("ZlibDriver", () => {
  it("logs in and searches, producing a unified feed with relative acquisition hrefs", async () => {
    const { fetchImpl, calls } = installZlibMock();
    const driver = new ZlibDriver({
      domain: "singlelogin.me",
      username: "me@example.com",
      password: "pw",
    });

    const feed = await driver.search("dune", fetchImpl);

    expect(calls[0]).toContain("POST login email=me%40example.com&password=pw");
    expect(calls[1]).toContain("POST search message=dune&limit=50&page=1");
    expect(feed.title).toBe("Z-Library · dune");
    expect(feed.publications).toHaveLength(2);

    const dune = feed.publications[0];
    expect(dune.title).toBe("Dune");
    expect(dune.authors).toEqual(["Frank Herbert"]);
    expect(dune.issued).toBe("1965");
    expect(dune.acquisitions[0].href).toBe(
      "/opds/zlib/download?id=101&hash=abcd1234&extension=epub",
    );
    expect(dune.acquisitions[0].extension).toBe("epub");

    const foundation = feed.publications[1];
    expect(foundation.authors).toEqual(["Isaac Asimov"]);
    expect(foundation.acquisitions[0].extension).toBe("pdf");
  });

  it("downloads by id/hash with auth headers and magic validation", async () => {
    const { fetchImpl, calls } = installZlibMock();
    const driver = new ZlibDriver({
      domain: "singlelogin.me",
      username: "me@example.com",
      password: "pw",
    });

    const bytes = await driver.download(
      { id: "101", hash: "abcd1234", extension: "epub" },
      fetchImpl,
    );
    expect(new TextDecoder().decode(bytes)).toContain("PK-zlib-epub-body");
    const dl = calls.find((c) => c.includes("GET") && c.includes("abcd1234"));
    expect(dl).toBeDefined();
  });

  it("throws when login response lacks credentials", async () => {
    const fetchImpl: Fetcher = async () =>
      new Response(JSON.stringify({ success: true, user_profile: {} }), { status: 200 });
    const driver = new ZlibDriver({
      domain: "singlelogin.me",
      username: "a",
      password: "b",
    });
    await expect(driver.search("x", fetchImpl)).rejects.toThrow(/login failed/);
  });

  it("rejects non-book download payloads", async () => {
    const fetchImpl: Fetcher = async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/eapi/user/login")) return new Response(LOGIN_OK, { status: 200 });
      return new Response(new TextEncoder().encode("<html>waiting</html>"), { status: 200 });
    };
    const driver = new ZlibDriver({
      domain: "singlelogin.me",
      username: "a",
      password: "b",
    });
    await expect(
      driver.download({ id: "1", hash: "h" }, fetchImpl),
    ).rejects.toThrow(/non-book/);
  });
});
