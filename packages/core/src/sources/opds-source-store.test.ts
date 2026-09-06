import { beforeEach, describe, expect, it } from "vitest";

import { type IPlatformService, setPlatformService } from "../services/platform";
import {
  OPDS_MAX_SOURCES,
  opdsSourceKey,
  useOpdsSourcesStore,
} from "./opds-source-store";
import { opdsSourceSecretKey, type OpdsSource } from "./opds";

/** 假平台:内存 kv map */
function installKvPlatform() {
  const kv = new Map<string, string>();
  setPlatformService({
    async kvGetItem(key: string) {
      return kv.get(key) ?? null;
    },
    async kvSetItem(key: string, value: string) {
      kv.set(key, value);
    },
    async kvRemoveItem(key: string) {
      kv.delete(key);
    },
    async kvGetAllKeys() {
      return Array.from(kv.keys());
    },
  } as unknown as IPlatformService);
  return kv;
}

function makeSource(id: string, overrides: Partial<OpdsSource> = {}): OpdsSource {
  return {
    id,
    name: `书源${id}`,
    url: `https://server-${id}.com/opds`,
    username: "",
    ...overrides,
  };
}

// 模块级 zustand 单例,每个用例重置状态
function resetStore() {
  useOpdsSourcesStore.setState({ sources: [], loaded: false });
}

describe("useOpdsSourcesStore", () => {
  beforeEach(() => {
    resetStore();
  });

  it("hydrate loads sources from kv with split keys and hasPassword flag", async () => {
    const kv = installKvPlatform();
    kv.set("opds_sources", JSON.stringify(["a", "b"]));
    kv.set(opdsSourceKey("a"), JSON.stringify(makeSource("a")));
    kv.set(opdsSourceKey("b"), JSON.stringify(makeSource("b")));
    kv.set(opdsSourceSecretKey("b"), "pw");

    await useOpdsSourcesStore.getState().hydrate();
    const { sources } = useOpdsSourcesStore.getState();

    expect(sources).toHaveLength(2);
    expect(sources.find((s) => s.id === "a")?.hasPassword).toBe(false);
    expect(sources.find((s) => s.id === "b")?.hasPassword).toBe(true);
  });

  it("hydrate is idempotent and tolerant of corrupt index/source JSON", async () => {
    const kv = installKvPlatform();
    kv.set("opds_sources", "{{corrupt");
    kv.set(opdsSourceKey("bad"), "not json");

    await useOpdsSourcesStore.getState().hydrate();
    await useOpdsSourcesStore.getState().hydrate();
    expect(useOpdsSourcesStore.getState().sources).toHaveLength(0);
  });

  it("saveSource persists list index + source key + secret; empty password keeps existing secret", async () => {
    const kv = installKvPlatform();
    const store = useOpdsSourcesStore.getState();

    await store.saveSource(makeSource("a"), "p1");
    expect(useOpdsSourcesStore.getState().sources).toHaveLength(1);
    expect(kv.get("opds_sources")).toBe(JSON.stringify(["a"]));
    expect(kv.get(opdsSourceSecretKey("a"))).toBe("p1");

    // 编辑:密码留空 → secret 保留
    await store.saveSource(makeSource("a", { name: "改名" }), "");
    expect(useOpdsSourcesStore.getState().sources[0].name).toBe("改名");
    expect(kv.get(opdsSourceSecretKey("a"))).toBe("p1");

    // 编辑:提供新密码 → 覆盖
    await store.saveSource(makeSource("a", { name: "再改名" }), "p2");
    expect(kv.get(opdsSourceSecretKey("a"))).toBe("p2");
  });

  it("getPassword reads the secret key", async () => {
    installKvPlatform();
    await useOpdsSourcesStore.getState().saveSource(makeSource("a"), "pw1");
    await expect(useOpdsSourcesStore.getState().getPassword("a")).resolves.toBe("pw1");
    await expect(useOpdsSourcesStore.getState().getPassword("missing")).resolves.toBe("");
  });

  it("removeSource deletes source + secret and updates the index", async () => {
    const kv = installKvPlatform();
    await useOpdsSourcesStore.getState().saveSource(makeSource("a"), "p");
    await useOpdsSourcesStore.getState().saveSource(makeSource("b"), "");

    await useOpdsSourcesStore.getState().removeSource("a");

    expect(useOpdsSourcesStore.getState().sources.map((s) => s.id)).toEqual(["b"]);
    expect(kv.get("opds_sources")).toBe(JSON.stringify(["b"]));
    expect(kv.has(opdsSourceKey("a"))).toBe(false);
    expect(kv.has(opdsSourceSecretKey("a"))).toBe(false);
  });

  it("rejects more than OPDS_MAX_SOURCES sources", async () => {
    installKvPlatform();
    const store = useOpdsSourcesStore.getState();
    for (let i = 0; i < OPDS_MAX_SOURCES; i++) {
      await store.saveSource(makeSource(`s${i}`), "");
    }
    await expect(
      useOpdsSourcesStore.getState().saveSource(makeSource("overflow"), ""),
    ).rejects.toThrow(/limit/);
    expect(useOpdsSourcesStore.getState().sources).toHaveLength(OPDS_MAX_SOURCES);
  });

  it("repairs a corrupt index by rebuilding from memory on next save", async () => {
    const kv = installKvPlatform();
    kv.set("opds_sources", "{broken");
    await useOpdsSourcesStore.getState().saveSource(makeSource("a"), "");
    expect(useOpdsSourcesStore.getState().sources).toHaveLength(1);
    const indexRaw = kv.get("opds_sources");
    expect(indexRaw).not.toBeNull();
    expect(JSON.parse(indexRaw as string)).toEqual(["a"]);
  });
});
