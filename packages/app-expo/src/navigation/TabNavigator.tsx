import { BookOpenIcon, MessageSquareIcon, NotebookPenIcon, UserIcon } from "@/components/ui/Icon";
import { useResponsiveLayout } from "@/hooks/use-responsive-layout";
import { ChatScreen } from "@/screens/ChatScreen";
import { LibraryScreen } from "@/screens/LibraryScreen";
import { NotesScreen } from "@/screens/NotesScreen";
import { ProfileScreen } from "@/screens/ProfileScreen";
import { useTheme } from "@/styles/ThemeContext";
/**
 * TabNavigator — 4 tab 底部栏 + 页面间左右滑动切换(普通滑动手感)。
 * 手势:全屏水平滑动(≥70px 且水平主导)→ 切换相邻 tab;底部栏点击照常。
 */
import {
  createBottomTabNavigator,
  type BottomTabBarProps,
} from "@react-navigation/bottom-tabs";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useCallback, useEffect, useRef } from "react";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export type TabParamList = {
  Library: undefined;
  Chat: undefined;
  Notes: { bookId?: string } | undefined;
  Profile: undefined;
};

const TAB_ROUTES = ["Library", "Chat", "Notes", "Profile"] as const;
const TAB_ICONS = [BookOpenIcon, MessageSquareIcon, NotebookPenIcon, UserIcon];
const TAB_LABEL_KEYS = ["tabs.library", "tabs.ai", "tabs.notes", "tabs.profile"];

const Tab = createBottomTabNavigator<TabParamList>();

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

  // 滑动切换所需:当前 index 与 tab 导航器引用(由 tabBar 组件同步)
  const tabNavRef = useRef<BottomTabBarProps["navigation"] | null>(null);
  const idxSV = useSharedValue(0);

  const switchTo = useCallback((i: number) => {
    if (i >= 0 && i < TAB_ROUTES.length) {
      tabNavRef.current?.navigate(TAB_ROUTES[i] as never);
    }
  }, []);

  // 页面间滑动:水平主导且 ≥70px → 相邻 tab(普通滑动切换)
  const swipeGesture = useRef(
    Gesture.Pan()
      .activeOffsetX([-20, 20])
      .failOffsetY([-30, 30])
      .onEnd((e) => {
        const dominant = Math.abs(e.translationX) > Math.abs(e.translationY) * 1.2;
        if (!dominant || Math.abs(e.translationX) < 70) return;
        const next = e.translationX < 0 ? idxSV.value + 1 : idxSV.value - 1;
        runOnJS(switchTo)(next);
      }),
  ).current;

  const renderTabBar = useCallback(
    (props: BottomTabBarProps) => (
      <ReadAnyTabBar
        {...props}
        t={t}
        colors={colors}
        layout={layout}
        bottomInset={bottomInset}
        idxSV={idxSV}
        tabNavRef={tabNavRef}
      />
    ),
    [t, colors, layout, bottomInset, idxSV],
  );


  return (
    <GestureDetector gesture={swipeGesture}>
      <View style={{ flex: 1 }}>
        <Tab.Navigator
          safeAreaInsets={{ ...insets, bottom: bottomInset }}
          screenOptions={{
            headerShown: false,
            tabBarHideOnKeyboard: false,
            // v7 内置滑切过渡:左右滑动切换(带位移动画)
            animation: "shift",
            sceneStyle: {
              paddingBottom: Platform.OS === "android" && insets.bottom === 0 ? 4 : 0,
            },
          }}
          tabBar={renderTabBar}
        >
          <Tab.Screen name="Library" component={LibraryScreen} />
          <Tab.Screen name="Chat" component={ChatScreen} />
          <Tab.Screen name="Notes" component={NotesScreen} />
          <Tab.Screen name="Profile" component={ProfileScreen} />
        </Tab.Navigator>
      </View>
    </GestureDetector>
  );
}

/** 自定义底部栏(稳定组件):同步当前 tab 索引/导航引用,供滑动切换手势使用 */
function ReadAnyTabBar({
  state,
  navigation,
  t,
  colors,
  layout,
  bottomInset,
  idxSV,
  tabNavRef,
}: BottomTabBarProps & {
  t: ReturnType<typeof useTranslation>["t"];
  colors: ReturnType<typeof useTheme>["colors"];
  layout: ReturnType<typeof useResponsiveLayout>;
  bottomInset: number;
  idxSV: ReturnType<typeof useSharedValue<number>>;
  tabNavRef: React.RefObject<BottomTabBarProps["navigation"] | null>;
}) {
  const baseTabBarHeight = layout.isTabletLandscape ? 72 : layout.isTablet ? 76 : 60;
  const tabBarHeight = baseTabBarHeight + bottomInset;

  useEffect(() => {
    idxSV.value = state.index;
    tabNavRef.current = navigation;
  });

  return (
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
      {state.routes.map((route, i) => {
        const Icon = TAB_ICONS[i];
        const focused = state.index === i;
        const color = focused ? colors.primary : colors.mutedForeground;
        return (
          <TouchableOpacity
            key={route.key}
            style={styles.tabItem}
            onPress={() => navigation.navigate(route.name, route.params as never)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityState={focused ? { selected: true } : undefined}
            accessibilityLabel={t(TAB_LABEL_KEYS[i])}
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
              {t(TAB_LABEL_KEYS[i])}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
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
