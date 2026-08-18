/**
 * Local ECDICT dictionary lookup (stardict.db, ~3.4M entries).
 * Queries the Rust ecdict_lookup command — fully offline, millisecond-fast.
 */

import { invoke } from "@tauri-apps/api/core";

export interface ECDICTEntry {
  word: string;
  phonetic: string;
  translation: string;
  pos: string;
  exchange: string;
}

export async function lookupLocalDictionary(word: string): Promise<ECDICTEntry | null> {
  try {
    const entry = await invoke<ECDICTEntry | null>("ecdict_lookup", { word });
    return entry;
  } catch (err) {
    console.warn("[ECDICT] lookup failed:", err);
    return null;
  }
}
