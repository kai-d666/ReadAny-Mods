/**
 * useReaderSystemInfo — manages system status bar, safe area inset, clock, and battery.
 */
import * as Battery from "expo-battery";
import { useEffect, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatReaderClock } from "./reader-constants";

export interface UseReaderSystemInfoOptions {
  isIPadLayout: boolean;
  baseTopInset: number;
}

export interface UseReaderSystemInfoResult {
  readerClock: string;
  batteryLevel: number | null;
  batteryState: Battery.BatteryState;
  isBatteryCharging: boolean;
  stableTopInset: number;
  insets: ReturnType<typeof useSafeAreaInsets>;
}

export function useReaderSystemInfo({
  isIPadLayout,
  baseTopInset,
}: UseReaderSystemInfoOptions): UseReaderSystemInfoResult {
  const insets = useSafeAreaInsets();

  const [readerClock, setReaderClock] = useState(() => formatReaderClock(new Date()));
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);
  const [batteryState, setBatteryState] = useState<Battery.BatteryState>(
    Battery.BatteryState.UNKNOWN,
  );
  const [stableTopInset, setStableTopInset] = useState(() =>
    Math.max(insets.top, isIPadLayout ? 24 : baseTopInset),
  );

  // Stable top inset
  useEffect(() => {
    const nextInset = Math.max(insets.top, isIPadLayout ? 24 : baseTopInset);
    setStableTopInset((prev) => {
      if (isIPadLayout) return Math.max(prev, nextInset);
      return nextInset;
    });
  }, [baseTopInset, insets.top, isIPadLayout]);

  // Clock
  useEffect(() => {
    const updateClock = () => setReaderClock(formatReaderClock(new Date()));
    updateClock();
    const timer = setInterval(updateClock, 30000);
    return () => clearInterval(timer);
  }, []);

  // Battery
  useEffect(() => {
    let mounted = true;

    const syncBattery = async () => {
      try {
        const [nextLevel, nextState] = await Promise.all([
          Battery.getBatteryLevelAsync(),
          Battery.getBatteryStateAsync(),
        ]);
        if (mounted) {
          setBatteryLevel(typeof nextLevel === "number" && nextLevel >= 0 ? nextLevel : null);
          setBatteryState(nextState);
        }
      } catch {
        if (mounted) {
          setBatteryLevel(null);
          setBatteryState(Battery.BatteryState.UNKNOWN);
        }
      }
    };

    syncBattery();
    const levelSubscription = Battery.addBatteryLevelListener(({ batteryLevel: nextLevel }) => {
      setBatteryLevel(typeof nextLevel === "number" && nextLevel >= 0 ? nextLevel : null);
    });
    const stateSubscription = Battery.addBatteryStateListener(({ batteryState: nextState }) => {
      setBatteryState(nextState);
    });

    return () => {
      mounted = false;
      levelSubscription.remove();
      stateSubscription.remove();
    };
  }, []);

  const isBatteryCharging =
    batteryState === Battery.BatteryState.CHARGING ||
    batteryState === Battery.BatteryState.FULL;

  return { readerClock, batteryLevel, batteryState, isBatteryCharging, stableTopInset, insets };
}
