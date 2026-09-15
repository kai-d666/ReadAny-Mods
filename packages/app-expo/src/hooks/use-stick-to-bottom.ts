import { type RefObject, useCallback, useRef, useState } from "react";
import type { FlatList, LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";

/**
 * Keeps a chat list pinned to the bottom while content streams in, and lets go
 * the moment the reader scrolls up to re-read something.
 *
 * Three independent signals have to stay separate — conflating them is what
 * made the old implementation yank people back down:
 *
 *   pin            "the reader still wants to follow" — changed ONLY by real
 *                  gestures, the jump button, or a thread change
 *   userScrolling  the finger is down, plus an inertia grace period
 *   scrollLock     we just scrolled programmatically; our own onScroll must not
 *                  be read back as a gesture
 *
 * The pattern is the one `components/reader/TTSPage.tsx` already uses for
 * lyric auto-centering — the only place in the repo that had it.
 */

/** Distance from the bottom (dp) still counted as "at the bottom". */
export const BOTTOM_THRESHOLD = 80;

/** Inertia keeps firing onScroll after the finger lifts — stay "user scrolling"
 *  long enough to cover it (same 900ms TTSPage settled on). */
const USER_SCROLL_RELEASE_MS = 900;

/** Our own scroll emits onScroll; ignore the echo for this long. */
const PROGRAMMATIC_LOCK_MS = 250;

/**
 * True when the viewport's bottom edge sits within `threshold` of the content's
 * bottom. Content shorter than the viewport cannot scroll at all, so it counts
 * as being at the bottom (the distance goes negative).
 *
 * Exactly `threshold` away is NOT near the bottom — same boundary the previous
 * implementation used.
 */
export function isNearBottom(
  contentOffsetY: number,
  contentHeight: number,
  viewportHeight: number,
  threshold: number = BOTTOM_THRESHOLD,
): boolean {
  return contentHeight - contentOffsetY - viewportHeight < threshold;
}

export interface StickToBottom {
  listRef: RefObject<FlatList | null>;
  /** False once the reader has scrolled away — drives the "back to bottom" button. */
  isPinned: boolean;
  /** Re-arm following for the rest of this stream, without jumping. */
  pinToBottom: () => void;
  /** Re-arm and jump immediately (thread change, explicit button press). */
  resetToBottom: (animated?: boolean) => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onScrollBeginDrag: () => void;
  onScrollEndDrag: () => void;
  onContentSizeChange: (width: number, height: number) => void;
  onLayout: (event: LayoutChangeEvent) => void;
}

export function useStickToBottom(): StickToBottom {
  const listRef = useRef<FlatList>(null);
  const [isPinned, setIsPinnedState] = useState(true);

  const pinRef = useRef(true);
  const userScrollingRef = useRef(false);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const programmaticLockUntilRef = useRef(0);
  // Measured in the callbacks; used to compute the target offset. Zero until
  // the first layout, which is why scrolling has to wait for it.
  const contentHeightRef = useRef(0);
  const viewportHeightRef = useRef(0);

  const setPinned = useCallback((next: boolean) => {
    if (pinRef.current === next) return;
    pinRef.current = next;
    setIsPinnedState(next);
  }, []);

  const scrollToBottom = useCallback((animated: boolean) => {
    programmaticLockUntilRef.current = Date.now() + PROGRAMMATIC_LOCK_MS;

    const viewportHeight = viewportHeightRef.current;
    if (viewportHeight <= 0) {
      // No layout yet — there is no target offset to compute. scrollToEnd lands
      // in the same place, and the size callback will correct it right after.
      listRef.current?.scrollToEnd({ animated });
      return;
    }
    listRef.current?.scrollToOffset({
      offset: Math.max(0, contentHeightRef.current - viewportHeight),
      animated,
    });
  }, []);

  const pinToBottom = useCallback(() => setPinned(true), [setPinned]);

  const resetToBottom = useCallback(
    (animated = false) => {
      setPinned(true);
      scrollToBottom(animated);
    },
    [scrollToBottom, setPinned],
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      contentHeightRef.current = contentSize.height;
      viewportHeightRef.current = layoutMeasurement.height;

      // Our own jump, read back — not a gesture.
      if (Date.now() < programmaticLockUntilRef.current) return;
      // Content growth and viewport changes fire this too (the keyboard shrinks
      // the viewport by ~300dp, which would otherwise look exactly like the
      // reader scrolling up). Only a gesture may move the pin.
      if (!userScrollingRef.current) return;

      setPinned(
        isNearBottom(contentOffset.y, contentSize.height, layoutMeasurement.height),
      );
    },
    [setPinned],
  );

  const onScrollBeginDrag = useCallback(() => {
    userScrollingRef.current = true;
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
  }, []);

  const onScrollEndDrag = useCallback(() => {
    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = setTimeout(() => {
      userScrollingRef.current = false;
    }, USER_SCROLL_RELEASE_MS);
  }, []);

  const onContentSizeChange = useCallback(
    (_width: number, height: number) => {
      contentHeightRef.current = height;
      // This can beat the first layout; scrolling now would target a bogus
      // offset. Wait until we know how tall the viewport actually is.
      if (viewportHeightRef.current <= 0) return;
      if (pinRef.current) scrollToBottom(false);
    },
    [scrollToBottom],
  );

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout;
      const changed = height !== viewportHeightRef.current;
      viewportHeightRef.current = height;
      // The keyboard resizing the list is not a user gesture: a pinned list has
      // to follow it instead of quietly falling out of following.
      if (changed && pinRef.current) scrollToBottom(false);
    },
    [scrollToBottom],
  );

  return {
    listRef,
    isPinned,
    pinToBottom,
    resetToBottom,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    onContentSizeChange,
    onLayout,
  };
}
