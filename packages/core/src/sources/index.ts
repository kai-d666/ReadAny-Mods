/**
 * OPDS 书源(在线目录)模块入口。
 * 桌面端不引入本模块(core 主入口 index.ts 未导出 → 桌面 bundle 零影响)。
 */

export * from "./opds";
export * from "./opds2";
export * from "./opds-client";
export * from "./opds-source-store";
