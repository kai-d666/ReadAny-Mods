# AI 工具矩阵与双维度裁剪

> 2026-08-25。描述 ReadAny AI 助手的工具注册与裁剪架构。随源码更新,git 管理。

## 总览

AI 助手有两维正交的决策,各自决定一件事:

| 维度 | 决定 | 执行位置 |
|---|---|---|
| **书籍向量化与否** | `getAvailableTools()` 产出**哪组检索工具** | `packages/core/src/ai/tools/index.ts` (`getAvailableTools`) |
| **chatMode(标准/lite)** | 拿到工具后**怎么裁剪 + 怎么驱动** | `packages/core/src/ai/agents/reading-agent.ts` (`streamReadingAgent`) |

## 工具分组与注册条件

| 工具组 | 出现条件 | 标准模式 | lite 模式 |
|---|---|---|---|
| context 5 个(getCurrentChapter/getSelection/getSurroundingContext/getReadingProgress/getRecentHighlights) | 有书即注册 | ✅ 意图路由裁剪 | ✅ 白名单 |
| rag 3 个(ragSearch/ragToc/ragContext) | **仅向量化书** (`isVectorized=true`) | ✅ 路由 | ✅ 白名单 |
| fallback 4 个(fallbackSearch/fallbackToc/fallbackChapterContext/resolveChapterReference-fallback版) | **仅未向量化书** | ✅ 路由 | ✅ 白名单 |
| 分析 5 个(summarize/extractEntities/analyzeArguments/findQuotes/compareSections) | **仅向量化书** | ✅ 路由 | ❌ `LITE_FORBIDDEN_TOOLS` |
| 书库类(listBooks/searchAllHighlights/.../manageBookGroups) | 总有 | ✅ 路由 | ❌ 白名单不含(仅保留 mindmap) |
| 技能(skillToTool → getSkills 等) | 用户启用的技能 | ✅ 动态注入 | ❌ lite 不加载技能(`enabledSkills=[]`) |
| addCitation/getAnnotations | 有书 | ✅ | ❌(lite 无引用注入) |
| mindmap | 总有 | ✅ | ✅ |

> **混合点**:`resolveChapterReference` 在两个分支都存在(RAG 版 / fallback 版,同名不同实现)。白名单按名字过滤时命中同名,故 lite 下它总在场。

## 双维度组合矩阵

| | **标准模式** | **lite 模式** |
|---|---|---|
| **向量化书** | 全集 → 意图路由裁剪 → ReAct(recursion 24) | 全集 → 白名单过滤(rag* 保留) → 直接问(recursion 6) |
| **未向量化书** | 全集(fallback 组)→ 意图路由裁剪 → 循环 | 全集 → 白名单(fallback* 保留)→ 直接问 |
| **无书(全局聊天)** | 一般工具(书库/统计/技能)→ 路由 → 循环 | 一般工具(仅 mindmap 等)→ 直接问 |

## 代码路径

### 1. 工具注册:`packages/core/src/ai/tools/index.ts`

```ts
export function getAvailableTools({ bookId, isVectorized, enabledSkills }): ToolDefinition[] {
  // 1. 一般工具(无书也有):listBooks → manageBookGroups
  // 2. 有书:context 5 个
  // 3. isVectorized=true → rag 3 + 分析 5 + addCitation/getAnnotations
  //    isVectorized=false → fallback 4 + addCitation/getAnnotations
  // 4. enabledSkills → skillToTool
}
```

### 2. lite 常量(同上文件)

```ts
export const LITE_DEFAULT_TOOLS = [
  "getCurrentChapter", "getSelection", "getSurroundingContext",
  "getReadingProgress", "getRecentHighlights",
  "ragSearch", "ragToc", "ragContext",       // 向量化书用
  "fallbackSearch", "fallbackToc", "fallbackChapterContext",  // 未向量化书用
  "resolveChapterReference", "mindmap",
];
export const LITE_FORBIDDEN_TOOLS = new Set(["summarize", "extractEntities",
  "analyzeArguments", "findQuotes", "compareSections"]);  // 重型分析,任何情况禁
```

### 3. 裁剪:`packages/core/src/ai/agents/reading-agent.ts`

```ts
const liteWhitelist = new Set((liteToolIds ?? LITE_DEFAULT_TOOLS).filter(不in FORBIDDEN));
const allAvailable = getAvailableTools({bookId, isVectorized, enabledSkills: isLite?[]:enabledSkills});
const tools = isLite
  ? allAvailable.filter(t => liteWhitelist.has(t.name))
  : filterToolsForQuestion({ tools: allAvailable, category: questionCategory, isVectorized });
```

- **标准模式**:意图路由 `filterToolsForQuestion` 按问题类型分类(8 类),每类配工具子集,再 ReAct(recursion 24/chapter 24)
- **lite 模式**:固定白名单过滤,`recursionLimit=6`(最多一次工具往返),无路由、无技能、无记忆压缩、无引用注入

## 演进历史(关键提交)

- **lite 模式引入**:白名单最初只含 fallback* (无 rag*),导致向量化书 lite 只有 7 工具 → 问章节匹配失败/recursion 超限
- **2026-08-25 修复**:`LITE_DEFAULT_TOOLS` 增加 rag* 三件套;`LITE_FORBIDDEN_TOOLS` 只保留 5 个重型分析 → 向量化书 lite = context5 + mindmap + resolveChapterReference + rag3 = 10 工具,未向量化 = 对应 fallback 版
- **fallback 移动端修复(单常驻阅读器会话)**:`BookContentSearchProvider` 注册制,移动端用 foliate 增量搜索(见 `packages/app-expo/src/lib/rag/reader-search-session.tsx`),桌面未注册走本地解析

## 相关文件

- `packages/core/src/ai/tools/index.ts` — 注册 + lite 常量
- `packages/core/src/ai/agents/reading-agent.ts` — 裁剪 + 分支
- `packages/core/src/ai/tools/fallback-content-tools.ts` — fallback 三件套(provider 优先)
- `packages/core/src/ai/fallback-content-service.ts` — `BookContentSearchProvider` 接口
- `packages/app-expo/src/lib/rag/reader-search-session.tsx` — 移动端会话实现
