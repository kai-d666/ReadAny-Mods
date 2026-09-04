/**
 * 本地 ECDICT 词典查询(移动端)。
 *
 * 词典库:stardict 系 SQLite 精简版(与桌面端同源:桌面 Tauri 命令查
 * `dictionary/stardict.db`),移动端字典由「本地词典」下载中心放到
 * `<documentDirectory>/readany-dicts/stardict.db`(见 lib/dict/dictionary-download.ts)。
 * 库必须由下载中心安装(唯一来源,无隐藏兜底路径);未安装查询 → null,
 * 由调用方按「AI 兜底」开关走 AI 查词。查询语义与桌面端一致:
 * 词条精确匹配(word NOCASE,忽略大小写)。
 */

import { File } from "expo-file-system";
import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { DICT_LOCAL_FILE } from "@/lib/dict/dictionary-download";

export interface ECDICTEntry {
  word: string;
  phonetic: string;
  translation: string;
  pos: string;
  exchange: string;
}

let dbPromise: Promise<SQLiteDatabase | null> | null = null;

async function openDictDb(): Promise<SQLiteDatabase | null> {
  try {
    const dictFile = new File(DICT_LOCAL_FILE);
    if (!dictFile.exists) {
      // 词典未安装(下载中心未安装或已删除):跳过本地查词,落 AI 兜底
      console.warn("[ECDICT] dict db not found, local lookup skipped");
      return null;
    }
    // 目录为文件路径去掉文件名(File API 无 parent;uri 以文件名结尾)
    return await openDatabaseAsync(dictFile.name, {}, dictFile.uri.slice(0, -dictFile.name.length));
  } catch (err) {
    console.warn("[ECDICT] open dict db failed:", err);
    return null;
  }
}

/** 移动端本地查询:词条精确命中;未就绪/未命中/出错返回 null(AI 兜底接管) */
export async function lookupLocalDictionary(word: string): Promise<ECDICTEntry | null> {
  if (!dbPromise) dbPromise = openDictDb();
  const db = await dbPromise;
  if (!db) return null;
  try {
    const row = await db.getFirstAsync<{
      word: string | null;
      phonetic: string | null;
      translation: string | null;
      pos: string | null;
      exchange: string | null;
    }>(
      "SELECT word, phonetic, translation, pos, exchange FROM stardict WHERE word = ? LIMIT 1",
      [word],
    );
    if (!row) {
      console.log(`[ECDICT] miss: ${word}`);
      return null;
    }
    console.log(`[ECDICT] hit: ${word}`);
    return {
      word: row.word ?? word,
      phonetic: row.phonetic ?? "",
      translation: row.translation ?? "",
      pos: row.pos ?? "",
      exchange: row.exchange ?? "",
    };
  } catch (err) {
    console.warn("[ECDICT] query failed:", err);
    return null;
  }
}
