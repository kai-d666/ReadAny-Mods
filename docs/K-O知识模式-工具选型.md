# K-O(Knowledge-Only)模式工具选型分析

> 状态:active(选型拍板中,2026-08-28)
> 日期:2026-08-28 · 决策人:用户 · 执行:Claude
> **背景**:K-O 定位调整为"知识为主 + 少量基础工具"(名称 Knowledge-Only 不改)。下表为现有全部 AI 工具的完整盘点,用于圈定 K-O 基础工具集。
> 配套:放松维度清单见同目录 `K-O模式-放松清单.md`;历史参考:`history-analysis/AI工具矩阵与双维度裁剪.md`。

## 一、全部现有工具总表(26 具名 + skill 动态类)

事件类型:CTX=上下文 · RAG=向量书检索 · FB=未向量书检索(互斥) · AN=分析 · ANN=注释/引用 · LIB=书库管理 · MM=思维导图 · SK=技能

| # | 工具 | 类别 | 用途 | 注册依赖 | 执行链路 & 限额 | 超时 | 剧透 |
|---|------|------|------|----------|------------------|------|------|
| 1 | getSurroundingContext | CTX | 当前位置/选区的前后文(已继承 getCurrentChapter) | 需 bookId | 内存快照 + 热通道 `getContextAroundCfi`(3.5s 竞速),锚定当前 CFI,切 6000 字符 | 8s | 基本否(锚当前位置) |
| 2 | getSelection | CTX | 用户当前选中文本 | 需 bookId | 纯内存快照,零 IO | 5s | 否 |
| 3 | getReadingProgress | CTX | 进度/当前章/百分比 | 需 bookId | 内存快照 + 1 次 DB | 5s | 否 |
| 4 | getRecentHighlights | CTX | 最近高亮(默认 10 条) | 需 bookId | DB getHighlights | 8s | 否(用户自建) |
| 5 | getAnnotations | ANN | 高亮+笔记各 20 条 | 需 bookId | DB,零 IO | 8s | 否(用户自建) |
| 6 | addCitation | ANN | 注册可点击引用(写操作) | 需 bookId | DB 精化 CFI;quotedText 截 200 字符;**剧透敏感** | 20s | 否(但书引用=剧透关联) |
| 7 | ragSearch | RAG | 全书语义检索"XX 在哪" | bookId + **向量化** | 向量库检索;MAX 4000 token,topK 5 | 30s | **是(全书任意未来内容)** |
| 8 | ragToc | RAG | 章标题列表 | bookId + 向量化 | getChunks/热通道 getToc(2s),limit 20 默认 | 20s | 轻微(仅标题) |
| 9 | ragContext | RAG | 某章前后 chunk 正文 | bookId + 向量化 | getChunks;MAX 3000 token | 30s | **是(任意章节)** |
| 10 | resolveChapterReference | RAG/FB | "第N章"→内部索引(向量/非向量版本同名互斥) | bookId + 相应向量态 | 热通道 getToc(2s)→getChunks/原书;preview 500 字符 | 45s 默认 | 否(仅映射) |
| 11 | fallbackSearch | FB | 未向量书**关键词**检索 | bookId + **非向量化** | 热通道 searchBookContent 优先,失败整本抽取打分;3600 token | 30s | **是(全书)** |
| 12 | fallbackToc | FB | 原书章节列表(href) | bookId + 非向量化 | 热通道 getToc / 原书抽取;limit 20,preview 180 字符 | 30s | 轻微 |
| 13 | fallbackChapterContext | FB | 读整章正文 | bookId + 非向量化 | 热通道 getChapter;3200 token | 30s | **是(整章)** |
| 14 | summarize | AN | 取章/书原文供主模型总结 | bookId + 向量化 | getChunks;章 1000-2500 / 书 1500-3500 token;**不调子模型** | 35s | **是(书级抽样)** |
| 15 | extractEntities | AN | 取原文供主模型抽实体 | bookId + 向量化 | getChunks;章 2000/书 3000 token | 35s | **是** |
| 16 | analyzeArguments | AN | 取原文供主模型析论证 | bookId + 向量化 | getChunks;3000 token | 35s | **是** |
| 17 | findQuotes | AN | 取原文供主模型找金句 | bookId + 向量化 | getChunks;4000 token | 35s | **是** |
| 18 | compareSections | AN | 取两章供主模型对比 | bookId + 向量化 | getChunks;每章 1500 token | 35s | **是(任意两章)** |
| 19 | listBooks | LIB | 列书库 | 通用(无 bookId) | DB getBooks | 45s 默认 | 否 |
| 20 | searchAllHighlights | LIB | 跨书查高亮 | 通用 | DB,limit 20 | 45s 默认 | 否(用户自建) |
| 21 | searchAllNotes | LIB | 跨书查笔记 | 通用 | DB | 45s 默认 | 否 |
| 22 | getReadingStats | LIB | 阅读统计(30 天) | 通用 | DB | 45s 默认 | 否 |
| 23 | classifyBooks | LIB | 元数据+TOC+1500 字符样本供打标签 | 通用 | DB + 样本 | 60s | 轻微 |
| 24 | tagBooks | LIB | 批量打标签 | 通用 | DB 写 | 30s | 否 |
| 25 | updateBookMetadata | LIB | 改书元数据/分组 | 通用 | DB 写 | 30s | 否 |
| 26 | manageBookGroups | LIB | 分组增删改 | 通用 | DB 写 | 30s | 否 |
| 27 | manageBookTags | LIB | 跨书标签管理 | 通用 | DB 写 | 30s | 否 |
| 28 | mindmap | MM | markdown→思维导图图核 | 通用 | 纯内存转 mermaid/markmap,**零 DB 零 LLM** | 10s | 否 |
| 29 | getSkills | SK | 列出技能/SOP | 通用 | DB 内存过滤 | 45s 默认 | 否 |
| 30 | skillToTool(动态) | SK | 每个启用技能生成一个独立工具(工具名=skill.id) | 依 enabledSkills | 纯内存,把 SOP 给主模型 | 45s 默认 | 视技能 |

## 二、分层建议(按 K-O"知识为主"定位)

### A 层 · 必留核 —— 确定性、毫秒-秒级、无 IO 重负、不剧透、与"知识回答"互补
| 工具 | 理由 |
|------|------|
| getReadingProgress | 位置是 K-O prompt 已带数据的工具版,一问"我读到哪"零成本应答 |
| getSurroundingContext | 唯一能把"当前这章"由知识猜变成"按当前位置回答"的工具(6000 字符) |
| getSelection | 选中提问的回答锚点 |
| getRecentHighlights | 用户笔记是好素材(与"知识+个人记录") |

### B 层 · 可选(条件性/K-O 扩边)
| 工具 | 利弊 |
|------|------|
| ragSearch / fallbackSearch | **+**"书中哪里提到 XX"这种半检索问题; **-** 30s、剧透全书、与"不读原文"定位冲突。二选一按向量态注册(白名单需同时列 rag+fallback 两系列) |
| ragToc / fallbackToc / resolveChapterReference | **+** 章节导航;"第N章讲什么"前置定位; **-** 章节标题其实已可随 A3 目录注入(prompt 版),工具版是"按需拉全量" |
| getAnnotations | 与 getRecentHighlights 重叠(多含 notes 各 20 条)——若只留一个可选它 |
| listBooks / getReadingStats | 通用问询(书库/统计)零成本兜底,知识问答中"我有什么书" |
| mindmap | 零成本图核,但生成内容依赖主模型;K-O 问答场景价值一般 |

### C 层 · 不推荐放 K-O
| 工具 | 理由 |
|------|------|
| summarize/extractEntities/analyzeArguments/findQuotes/compareSections | 标准模式的重分析(35s+全书抽样+剧透);且都是"喂原文给主模型",与 K-O 快定位冲突 |
| addCitation | 引用即剧透关联 + 写操作;K-O 不强调可点击引用(若你选 B 层检索,可再议) |
| classifyBooks/tagBooks/updateBookMetadata/manageBookGroups/manageBookTags/searchAllHighlights/searchAllNotes/getSkills* | 书库管理/技能类,与"知识问答"无关(*除非 B2 技能注入也放开) |

## 三、勾选表(请圈定)

**A 核(建议全留)**:☐ getReadingProgress ☐ getSurroundingContext ☐ getSelection ☐ getRecentHighlights

**B 可选**:☐ ragSearch+fallbackSearch(检索) ☐ ragToc+fallbackToc(目录) ☐ resolveChapterReference(章节定位) ☐ getAnnotations(替代高亮) ☐ listBooks ☐ getReadingStats ☐ mindmap

**C 不推荐**:☐ summarize ☐ extractEntities ☐ analyzeArguments ☐ findQuotes ☐ compareSections ☐ addCitation ☐ classifyBooks ☐ tagBooks ☐ updateBookMetadata ☐ manageBookGroups ☐ manageBookTags ☐ searchAllHighlights ☐ searchAllNotes ☐ getSkills/skill

## 四、附注(容易误认的事实)

1. **rag 系列与 fallback 系列互斥注册**(依 isVectorized),同名 `resolveChapterReference` 两个版本永不共存——白名单要"双态覆盖"须同时列两族(参照 `LITE_DEFAULT_TOOLS`,index.ts:64)。
2. 全部工具**均不触发额外子模型调用**(tools/ 无 llm-provider 导入),"分析类"只是取原文喂主模型。
3. 工具命名:书库统计是 `getReadingStats`(index.ts 头部注释写的 readingStats 是笔误)。
4. getCurrentChapter 已并入 getSurroundingContext(全库无该工具,注释见 context-tools.ts:5)。
5. 超时:未列出的工具统一 45s 默认(TOOL_TIMEOUT_MS_BY_NAME 外兜底)。
