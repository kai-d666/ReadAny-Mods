> 状态:snapshot(2026-08 设计文档;实现已落地 WebDavImportBrowserScreen/WebDavConnectSheet,当前同步体系见 claude-index 手册 §4)

# WebDAV Book Import Design

这组文档用于定义 ReadAny 的 `WebDAV 导入书籍` 能力。

目标不是先写代码，而是先把下面几件事定清楚：

1. WebDAV 导入和同步在产品上怎么区分。
2. “两种导入选项”到底是什么，应该怎么命名。
3. 移动端和桌面端的浏览、选择、导入、去重、异常状态怎么交互。
4. 工程上如何复用现有本地导入链路，而不是再造一套书籍入库流程。

文档目录：

- [01-product-positioning-and-ia.md](docs/webdav-import/01-product-positioning-and-ia.md)
- [02-interaction-flows-and-states.md](docs/webdav-import/02-interaction-flows-and-states.md)
- [03-implementation-roadmap.md](docs/webdav-import/03-implementation-roadmap.md)

当前约束：

- 暂不重写同步系统。
- 暂不把 WebDAV 导入和同步混在同一个流程里。
- 先冻结产品边界、交互层级和实现拆分，再进入页面与数据接线。
