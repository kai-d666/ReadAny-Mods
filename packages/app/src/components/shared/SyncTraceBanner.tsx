/**
 * 同步日志横幅(桌面端开发者调试,对齐安卓 devFlags.syncTraceBanner):
 * 顶部半透明悬浮条,显示同步状态 + 最近步骤("同步到哪一步了")。
 * 入口:开发者选项 →「同步日志横幅」开关。
 */
import { useSyncStore } from "@readany/core/stores/sync-store";
import { useDeveloperStore } from "@/stores/developer-store";

export function SyncTraceBanner() {
  const syncTraceBanner = useDeveloperStore((s) => s.syncTraceBanner);
  const trace = useSyncStore((s) => s.syncTrace);
  const status = useSyncStore((s) => s.status);

  if (!syncTraceBanner) return null;

  const recent = trace.slice(-8).reverse();
  const time = (ts: number) =>
    new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });

  return (
    <div className="pointer-events-none fixed top-12 left-1/2 -translate-x-1/2 z-[9999] w-[90%] max-w-xl rounded-xl bg-black/80 px-3.5 py-2.5 shadow-2xl backdrop-blur-md border border-white/10 text-white select-none">
      <div className="flex items-center justify-between text-xs font-bold tracking-wide text-white/90">
        <span>同步日志 · {status}</span>
        <span className="text-[10px] font-normal text-white/50">开发调试横幅</span>
      </div>
      <div className="mt-1.5 space-y-0.5 max-h-36 overflow-y-auto">
        {recent.length === 0 ? (
          <div className="text-[11px] text-white/50 italic">暂无同步日志记录</div>
        ) : (
          recent.map((t, i) => (
            <div
              key={`${t.ts}-${i}`}
              className="truncate text-[11px] text-white/80 font-mono"
            >
              <span className="text-white/40 mr-1.5">{time(t.ts)}</span>
              {t.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
