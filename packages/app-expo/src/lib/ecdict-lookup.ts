/**
 * 本地 ECDICT 词典查询(移动端接口位)。
 *
 * 桌面端(`packages/app/src/lib/ecdict-lookup.ts`)走 Tauri 命令查 stardict.db(~340 万词条)。
 * 移动端**尚未集成**本地词库:此实现先返回 null,由调用方按「AI 兜底」开关走 AI 查词。
 * 以后接入移动端本地词库(如 sqlite)时,仅需替换本实现,签名与桌面一致。
 */

export interface ECDICTEntry {
  word: string;
  phonetic: string;
  translation: string;
  pos: string;
  exchange: string;
}

/** 移动端本地查询:暂未集成,永远返回 null(命中能力留待本地词库接入)。 */
export async function lookupLocalDictionary(word: string): Promise<ECDICTEntry | null> {
  console.warn(`[ECDICT] local dictionary not integrated on mobile (lookup "${word}" skipped)`);
  return null;
}
