import { BookOpenIcon, MessageSquareIcon, NotebookPenIcon, UserIcon } from "@/components/ui/Icon";
import { BottomTabBarHeightContext } from "@react-navigation/bottom-tabs";
import { useGestureDebugStore } from "@/stores/gesture-debug-store";
import { usePanelControl } from "@/stores/panel-control";
import { useResponsiveLayout } from "@/hooks/use-responsive-layout";
import { ChatScreen } from "@/screens/ChatScreen";
import { LibraryScreen } from "@/screens/LibraryScreen";
import { NotesScreen } from "@/screens/NotesScreen";
import { ProfileScreen } from "@/screens/ProfileScreen";
import { useTheme } from "@/styles/ThemeContext";
/**
 * TabNavigator — 4 tab 底部栏 + 原生 Pager 无缝拼接翻页(跟手、吸附、相邻页贴边可见)。
 * 手感和布局由 react-native-pager-view(ViewPager2)提供;底部栏点击/setPage 同步。
 */
import { createContext, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import PagerView from "react-native-pager-view";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export type TabParamList = {
  Library: undefined;
  Chat: undefined;
  Notes: { bookId?: string } | undefined;
  Profile: undefined;
};

const TAB_SCREENS = [
  { key: "Library" as const, labelKey: "tabs.library" as const, Icon: BookOpenIcon, Screen: LibraryScreen },
  { key: "Chat" as const, labelKey: "tabs.ai" as const, Icon: MessageSquareIcon, Screen: ChatScreen },
  { key: "Notes" as const, labelKey: "tabs.notes" as const, Icon: NotebookPenIcon, Screen: NotesScreen },
  { key: "Profile" as const, labelKey: "tabs.profile" as const, Icon: UserIcon, Screen: ProfileScreen },
];

/** 当前 tab 激活上下文(替换原 per-tab screen 的 useFocusEffect 语义) */
export const TabActiveContext = createContext(true);

/** 下拉面板手势占用上下文:面板打开时禁掉外层 PagerView 水平滑动(防右滑误翻 tab) */
export const TabPanelGestureContext = createContext<
  { onOpenChange: (open: boolean) => void } | undefined
>(undefined);

export function TabNavigator() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const layout = useResponsiveLayout();

  const androidNavigationFallback =
    Platform.OS === "android" ? (insets.bottom > 0 ? 28 : layout.isTablet ? 32 : 40) : 0;
  const bottomInset =
    Platform.OS === "android" ? Math.max(insets.bottom, androidNavigationFallback) : insets.bottom;
  const baseTabBarHeight = layout.isTabletLandscape ? 72 : layout.isTablet ? 76 : 60;
  const tabBarHeight = baseTabBarHeight + bottomInset;

  const [index, setIndex] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const gestureMode = useGestureDebugStore((s) => s.mode);
  const pagerRef = useRef<PagerView>(null);

  const handlePanelOpenChange = useCallback((open: boolean) => {
    setPanelOpen(open);
  }, []);

  const goTo = useCallback((i: number) => {
    if (i < 0 || i >= TAB_SCREENS.length) return;
    if (i !== index) {
      setPanelOpen(false); // 解除锁定
      usePanelControl.getState().requestClose(); // 真正收回面板(第一页附庸,不同屏保留)
    }
    pagerRef.current?.setPage(i); // 原生吸附动画;onPageSelected 同步 index
    setIndex(i);
  }, [index]);

  return (
    <BottomTabBarHeightContext.Provider value={tabBarHeight}>
    <View style={{ flex: 1 }}>
      {/* 页面区:原生 Pager(无缝拼接,跟手 + 吸附,相邻页预渲染) */}
      <PagerView
        ref={pagerRef}
        style={styles.pager}
        initialPage={0}
        onPageSelected={(e) => setIndex(e.nativeEvent.position)}
        offscreenPageLimit={1}
        scrollEnabled={!panelOpen && gestureMode !== "vertical"}
      >
        {TAB_SCREENS.map((tab, i) => (
          <View key={tab.key} style={styles.page}>
            <TabPanelGestureContext.Provider value={{ onOpenChange: handlePanelOpenChange }}>
            <TabActiveContext.Provider value={i === index}>
              {tab.key === "Notes" ? (
                <NotesScreen
                  route={{ key: "Notes", name: "Notes" } as never}
                  navigation={undefined as never}
                />
              ) : (
                <tab.Screen />
              )}
            </TabActiveContext.Provider>
            </TabPanelGestureContext.Provider>
          </View>
        ))}
      </PagerView>

      {/* 底部栏 */}
      <View
        style={[
          styles.tabBar,
          {
            backgroundColor: colors.background,
            borderTopColor: colors.border,
            paddingBottom: bottomInset,
            height: tabBarHeight,
            paddingTop: layout.isTabletLandscape ? 8 : 4,
          },
        ]}
      >
        {TAB_SCREENS.map((tab, i) => {
          const focused = index === i;
          const color = focused ? colors.primary : colors.mutedForeground;
          const Icon = tab.Icon;
          return (
            <TouchableOpacity
              key={tab.key}
              style={styles.tabItem}
              onPress={() => goTo(i)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityState={focused ? { selected: true } : undefined}
              accessibilityLabel={t(tab.labelKey)}
            >
              <Icon size={24} color={color} />
              <Text
                style={[
                  styles.tabLabel,
                  {
                    color,
                    fontSize: layout.isTablet ? 13 : 12,
                    marginTop: layout.isTabletLandscape ? 4 : 2,
                  },
                ]}
              >
                {t(tab.labelKey)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
    </BottomTabBarHeightContext.Provider>
  );
}

const styles = StyleSheet.create({
  pager: { flex: 1 },
  page: { flex: 1 },
  tabBar: {
    flexDirection: "row",
    borderTopWidth: 0.5,
  },
  tabItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "column",
  },
  tabLabel: {
    fontWeight: "500",
  },
});
