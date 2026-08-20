# ReadAny 安卓与 Windows 功能差异报告

> 生成日期:2026-08-21。基于 git 31 条提交 + 两端源码扫描(app-expo 移动端 / app Tauri 桌面端)+ 逐点 grep 验证。
> 排除项:平台特化功能(三键隐藏/沉浸全屏/音量键翻页/WebView 预热/快捷键/命令面板/多标签休眠等)、翻译方式差异(安卓欧路 intent vs PC ECDICT 本地词典)。

## 结论

两端功能对齐度极高,真正的差异只有 2 个桌面独有大功能 + 1 个移动端独有小功能。

## 桌面(Windows)独有

| 功能 | 说明 | 位置 |
|---|---|---|
| EPUB 编辑工作区(最大差异) | 创建草稿、章节读取/编辑/保存(patch)、元数据编辑、历史/差异/校验、目录重建、撤销/丢弃、导出成品 EPUB。经 Rust 桥接捆绑 readany-cli | `app/src/components/epub-draft/EpubDraftWorkspace.tsx` + `src-tauri/src/readany_cli.rs` |
| 外部 AI / MCP 配置 | ReadAny CLI agent 安装 + MCP 配置(Claude/Cursor/Codex/OpenCode + readonly/editor/publisher 配置档)+ doctor 诊断 | `app/src/components/settings/ExternalAISettings.tsx` |
| PDF 缩放 50–300% + 重置(工具栏) | 桌面显式实现;移动端桥接口未见对应(同 foliate 引擎,低置信) | `FoliateViewer.tsx` / `ReaderToolbar.tsx` |

## 移动端独有

| 功能 | 说明 | 位置 |
|---|---|---|
| 徽章分享海报 | 自绘海报 captureRef → 系统分享/保存相册;桌面 BadgesDialog 无分享 | `app-expo/src/screens/BadgesScreen.tsx` |

## 曾被怀疑、实际两端都有(验证排除)

- 笔记导出 4 格式:Markdown / JSON / Obsidian / Notion(移动端 NotesView 同样支持)
- 评分 + 书评:桌面 BookDetailsDialog 有 reviews tab
- 按需下载(remote/downloading):桌面 BookCard 同样有"需下载/下载中"overlay + 点击下载
- LAN 同步 server/client 双模式 + 二维码:移动端 LanSection.tsx 同样可启动 server 出二维码
- UMD 导入:移动端同样走 umd-to-epub 转换
- 思维导图:移动端有 MindmapPartView / MermaidView
- WebDAV 目录浏览导入:桌面 DesktopImportActions 同样有 WebDavImportService
- TTS:5 引擎、歌词页、睡眠定时、悬浮球、连续朗读
- 同步:WebDAV/S3/LAN 三后端、配置迁移
- 知识库:向量化、本地嵌入(bge-small-zh/MiniLM)、语义搜索、混合检索、引用跳书
- AI:书聊/全局聊、思维链、防剧透、技能系统
- 统计:报告五维度、热力图、目标、徽章、年度快照
- 其他:软删除+重导入接回、缺失书恢复、Ruby 注音、自定义字体、章节翻译、书内搜索返回原位、更新检查、GitHub 反馈

## 备注

- 移动端无 ECDICT 本地词典,离线查词依赖欧路 App 是否安装(归入翻译方式差异,未列为功能差异)
- EPUB 编辑工作区依赖捆绑 CLI + 本地文件系统,移动端沙箱限制下移植难度大;MCP/外部 AI 配置概念上就是桌面开发工具链,不会上移动端
- 徽章海报分享移植成本极低,若想把移动端优势带回桌面是最顺手的一个
