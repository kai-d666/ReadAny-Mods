/**
 * Developer Store for Desktop — manages developer mode and experimental flags
 */
import { create } from "zustand";

interface DeveloperState {
  isDeveloperMode: boolean;
  localOpdsServer: boolean;
  setDeveloperMode: (enabled: boolean) => void;
  setLocalOpdsServer: (enabled: boolean) => void;
}

const STORAGE_KEY_DEV_MODE = "readany_desktop_developer_mode";
const STORAGE_KEY_LOCAL_OPDS = "readany_desktop_local_opds_server";

function getStoredBool(key: string, fallback: boolean): boolean {
  try {
    const val = localStorage.getItem(key);
    if (val === null) return fallback;
    return val === "true";
  } catch {
    return fallback;
  }
}

export const useDeveloperStore = create<DeveloperState>((set) => ({
  isDeveloperMode: getStoredBool(STORAGE_KEY_DEV_MODE, false),
  localOpdsServer: getStoredBool(STORAGE_KEY_LOCAL_OPDS, false),

  setDeveloperMode: (enabled: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY_DEV_MODE, String(enabled));
    } catch {
      // ignore
    }
    set({ isDeveloperMode: enabled });
  },

  setLocalOpdsServer: (enabled: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY_LOCAL_OPDS, String(enabled));
    } catch {
      // ignore
    }
    set({ localOpdsServer: enabled });
  },
}));
