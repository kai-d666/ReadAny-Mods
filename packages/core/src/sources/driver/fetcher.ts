/**
 * 内置书源服务端驱动的共享 HTTP 执行器(2026-09-06):
 * 统一走平台 XHR(与书源 UI 一致的超时/错误归一),支持 GET/POST(form 体)。
 * 不用 RN 全局 fetch —— 那里无超时与错误包装(网络抖动会被放大成"无法连接")。
 */
import { getPlatformService } from "../../services/platform";

export type Fetcher = (
  url: string,
  init?: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    responseType?: "text" | "arraybuffer";
  },
) => Promise<Response>;

const DRIVER_FETCH_TIMEOUT_MS = 15_000;

export const defaultFetcher: Fetcher = (url, init) =>
  getPlatformService().fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.headers,
    body: init?.body as BodyInit | undefined,
    responseType: init?.responseType ?? "text",
    timeoutMs: DRIVER_FETCH_TIMEOUT_MS,
  });

/** 仅当响应是"非 HTML"且达到最低大小时才判定为真实文件(加载/错误页兜底) */
export function looksLikeBookFile(bytes: Uint8Array, extension?: string): boolean {
  if (bytes.length < 64) return false;
  if (bytes[0] === 0x3c) return false; // "<" —— HTML 页
  const ext = (extension ?? "").toLowerCase();
  if (ext === "epub" || ext === "cbz") return bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (ext === "pdf") {
    return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  }
  return true;
}
