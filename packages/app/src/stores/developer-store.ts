/**
 * Developer Store for Desktop — manages developer mode and experimental flags
 */
import { create } from "zustand";

interface DeveloperState {
  isDeveloperMode: boolean;
  localOpdsServer: boolean;
  syncTraceBanner: boolean;
  liveAnswerStreaming: boolean;
  setDeveloperMode: (enabled: boolean) => void;
  setLocalOpdsServer: (enabled: boolean) => void;
  setSyncTraceBanner: (enabled: boolean) => void;
  setLiveAnswerStreaming: (enabled: boolean) => void;
}

const STORAGE_KEY_DEV_MODE = "readany_desktop_developer_mode";
const STORAGE_KEY_LOCAL_OPDS = "readany_desktop_local_opds_server";
const STORAGE_KEY_SYNC_TRACE = "readany_desktop_sync_trace_banner";
const STORAGE_KEY_LIVE_STREAMING = "readany_desktop_live_answer_streaming";

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
  syncTraceBanner: getStoredBool(STORAGE_KEY_SYNC_TRACE, false),
  liveAnswerStreaming: getStoredBool(STORAGE_KEY_LIVE_STREAMING, false),

  setDeveloperMode: (enabled: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY_DEV_MODE, String(enabled));
      if (!enabled) {
        localStorage.setItem(STORAGE_KEY_LIVE_STREAMING, "false");
      }
    } catch {
      // ignore
    }
    set({
      isDeveloperMode: enabled,
      ...(enabled ? {} : { liveAnswerStreaming: false }),
    });
  },

  setLocalOpdsServer: (enabled: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY_LOCAL_OPDS, String(enabled));
    } catch {
      // ignore
    }
    set({ localOpdsServer: enabled });
  },

  setSyncTraceBanner: (enabled: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY_SYNC_TRACE, String(enabled));
    } catch {
      // ignore
    }
    set({ syncTraceBanner: enabled });
  },

  setLiveAnswerStreaming: (enabled: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY_LIVE_STREAMING, String(enabled));
    } catch {
      // ignore
    }
    set({ liveAnswerStreaming: enabled });
  },
}));

