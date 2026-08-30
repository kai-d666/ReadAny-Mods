import { BookOpenIcon, MessageSquareIcon, NotebookPenIcon, UserIcon } from "@/components/ui/Icon";
import { useResponsiveLayout } from "@/hooks/use-responsive-layout";
import { ChatScreen } from "@/screens/ChatScreen";
import { LibraryScreen } from "@/screens/LibraryScreen";
import { NotesScreen } from "@/screens/NotesScreen";
import { ProfileScreen } from "@/screens/ProfileScreen";
import { useTheme } from "@/styles/ThemeContext";
/**
 * TabNavigator — 4 tab 底部栏,点击切换(2026-08-31 用户:基础界面左右滑动已删除,只保留点击)。
 * 上下面板(书库下拉开统计面板)不受影响,留在 PullDownHost 侧。
 */
import {
  createBottomTabNavigator,
  type BottomTabBarProps,
} from "@react-navigation/bottom-tabs";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useCallback } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePanelControl } from "@/stores/panel-control";

export type TabParamList = {
  Library: undefined;
  Chat: undefined;
  Notes: { bookId?: string } | undefined;
  Profile: undefined;
};

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

  const renderTabBar = useCallback(
    (props: BottomTabBarProps) => (
      <ReadAnyTabBar {...props} t={t} colors={colors} layout={layout} bottomInset={bottomInset} />
    ),
    [t, colors, layout, bottomInset],
  );

  return (
    <View style={{ flex: 1 }}>
      <Tab.Navigator
        safeAreaInsets={{ ...insets, bottom: bottomInset }}
        screenOptions={{
          headerShown: false,
          tabBarHideOnKeyboard: false,
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
  );
}

/** 自定义底部栏:纯点击切换(稳定性组件) */
function ReadAnyTabBar({
  state,
  navigation,
  t,
  colors,
  layout,
  bottomInset,
}: BottomTabBarProps & {
  t: ReturnType<typeof useTranslation>["t"];
  colors: ReturnType<typeof useTheme>["colors"];
  layout: ReturnType<typeof useResponsiveLayout>;
  bottomInset: number;
}) {
  const baseTabBarHeight = layout.isTabletLandscape ? 72 : layout.isTablet ? 76 : 60;
  const tabBarHeight = baseTabBarHeight + bottomInset;

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
            onPress={() => {
              // 跳转先行、面板收回同步进行(均在旧页滑出动画阶段),无"先收面板再跳"中间层
              navigation.navigate(route.name, route.params as never);
              usePanelControl.getState().requestClose();
            }}
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
