import { DEFAULT_S3_REMOTE_ROOT } from "./sync-backend";

function stripControlChars(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");
}

export function sanitizeS3RemoteRoot(remoteRoot: string): string {
  return stripControlChars(remoteRoot)
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
}

export function normalizeS3Key(remoteRoot: string, path: string): string {
  const root = sanitizeS3RemoteRoot(remoteRoot) || DEFAULT_S3_REMOTE_ROOT;
  let normalized = stripControlChars(path).trim().replace(/^\/+/, "");
  // 剥掉逻辑根字面(兼容旧 /readany 与新 /RA_dev),再拼用户配置的远端根,
  // 避免"双根拼接"(旧逻辑根只认 readany 时,新根 /RA_dev 会叠成 readany/RA_dev/…)
  normalized = normalized.replace(/^(?:readany|RA_dev)(?=\/|$)/, root);
  if (normalized === root || normalized.startsWith(`${root}/`)) {
    return normalized;
  }
  return `${root}/${normalized}`;
}

export function s3KeyToLogicalPath(remoteRoot: string, key: string): string {
  const root = sanitizeS3RemoteRoot(remoteRoot) || DEFAULT_S3_REMOTE_ROOT;
  const normalizedKey = key.replace(/\/+$/, "");
  if (normalizedKey === root) return "/RA_dev";
  if (normalizedKey.startsWith(`${root}/`)) {
    return `/RA_dev/${normalizedKey.slice(root.length + 1)}`;
  }
  return `/${normalizedKey}`;
}
