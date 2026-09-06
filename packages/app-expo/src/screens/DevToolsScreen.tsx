/**
 * DevToolsScreen — 开发者模式(隐藏入口:长按底部导航「我的」5s 振动进入)。
 *
 * 目前提供:启动动画开关(关闭 = 跳过 AnimatedSplash,启动直达书架)。
 * 开发者工具页,文案直接中文,不接 i18n;开关持久化在 settings-store devFlags。
 */
import {
  parseZlibAccessLink,
  useDriverConfigStore,
} from "@readany/core/sources/driver/driver-config-store";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { SettingsHeader } from "@/screens/settings/SettingsHeader";
import { useSettingsStore } from "@/stores";
import { useTheme } from "@/styles/ThemeContext";
import { fontSize, fontWeight, radius, spacing } from "@/styles/theme";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function DevToolsScreen() {
  const { colors } = useTheme();
  const { devFlags, setDevFlag } = useSettingsStore();
  const skipSplash = devFlags.skipSplashAnimation;
  const topBarBg = devFlags.readerTopBarBackground;
  const bottomBarBg = devFlags.readerBottomBarBackground;
  const syncTraceBanner = devFlags.syncTraceBanner;
  const localOpdsServer = devFlags.localOpdsServer;

  // Z-Library 驱动配置(本地书源服务端的上游之一)
  const zlConfig = useDriverConfigStore((s) => s.zlib);
  const [zlDomain, setZlDomain] = useState("");
  const [zlUsername, setZlUsername] = useState("");
  const [zlPassword, setZlPassword] = useState("");
  const [zlLink, setZlLink] = useState("");
  useEffect(() => {
    void useDriverConfigStore.getState().hydrate().then(() => {
      const cfg = useDriverConfigStore.getState().zlib;
      setZlDomain(cfg.domain);
      setZlUsername(cfg.username);
    });
  }, []);
  const handleSaveZlib = () => {
    void useDriverConfigStore
      .getState()
      .saveZlib(
        { enabled: zlConfig.enabled, domain: zlDomain.trim(), username: zlUsername.trim(), authId: zlConfig.authId },
        { password: zlPassword },
      )
      .then(() => setZlPassword(""));
  };
  const handleSaveZlibLink = () => {
    const parsed = parseZlibAccessLink(zlLink);
    if (!parsed) return;
    void useDriverConfigStore
      .getState()
      .saveZlib(
        { enabled: true, domain: parsed.domain, username: zlUsername.trim(), authId: parsed.authId },
        { userKey: parsed.authKey },
      )
      .then(() => {
        setZlDomain(parsed.domain);
        setZlLink("");
      });
  };
  const s = makeStyles(colors);

  return (
    <SafeAreaView style={[s.container, { backgroundColor: colors.background }]} edges={["top"]}>
      <SettingsHeader title="开发者模式" subtitle="长按「我的」5 秒进入" />
      <ScrollView style={s.scroll} contentContainerStyle={[s.scrollContent, { alignItems: "center" }]}>
        <View style={{ width: "100%", maxWidth: 720, gap: 24 }}>
          <View style={s.section}>
            <Text style={[s.sectionTitle, { color: colors.mutedForeground }]}>启动体验</Text>
            <View style={[s.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[s.rowTitle, { color: colors.foreground }]}>启动动画</Text>
                <Text style={[s.rowDesc, { color: colors.mutedForeground }]}>
                  关闭后跳过启动品牌动画,冷启动直达书架。修改后需重启 App 生效。
                </Text>
              </View>
              <Switch
                value={!skipSplash}
                onValueChange={(v) => setDevFlag("skipSplashAnimation", !v)}
                trackColor={{ true: colors.primary }}
              />
            </View>
          </View>
          <View style={s.section}>
            <Text style={[s.sectionTitle, { color: colors.mutedForeground }]}>同步调试</Text>
            <View style={[s.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[s.rowTitle, { color: colors.foreground }]}>同步日志横幅</Text>
                <Text style={[s.rowDesc, { color: colors.mutedForeground }]}>
                  顶部悬浮显示同步详细日志(状态 + 到哪一步了)。
                </Text>
              </View>
              <Switch
                value={syncTraceBanner}
                onValueChange={(v) => setDevFlag("syncTraceBanner", v)}
                trackColor={{ true: colors.primary }}
              />
            </View>
          </View>
          <View style={s.section}>
            <Text style={[s.sectionTitle, { color: colors.mutedForeground }]}>书源服务端</Text>
            <View style={[s.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[s.rowTitle, { color: colors.foreground }]}>本机书源服务端</Text>
                <Text style={[s.rowDesc, { color: colors.mutedForeground }]}>
                  实验性:在本机 127.0.0.1 启动 OPDS 书源服务(LibGen 上游),并自动加入书源列表。仅建议自用。
                </Text>
              </View>
              <Switch
                value={localOpdsServer}
                onValueChange={(v) => setDevFlag("localOpdsServer", v)}
                trackColor={{ true: colors.primary }}
              />
            </View>
            <View style={[s.zlCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={s.zlRow}>
                <Text style={s.zlLabel}>Z-Library 上游(实验性)</Text>
                <Switch
                  value={zlConfig.enabled}
                  onValueChange={(v) => {
                    void useDriverConfigStore
                      .getState()
                      .saveZlib(
                        { enabled: v, domain: zlDomain.trim(), username: zlUsername.trim(), authId: zlConfig.authId },
                        {},
                      );
                  }}
                  trackColor={{ true: colors.primary }}
                />
              </View>
              <TextInput
                style={s.zlInput}
                value={zlLink}
                onChangeText={setZlLink}
                placeholder="黏贴专属链接:https://z-library.sk/?remix_userid=…&remix_userkey=…"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
              />
              <TouchableOpacity style={s.zlSaveBtn} onPress={handleSaveZlibLink} activeOpacity={0.8}>
                <Text style={s.zlSaveText}>解析并保存专属链接</Text>
              </TouchableOpacity>
              <TextInput
                style={s.zlInput}
                value={zlDomain}
                onChangeText={setZlDomain}
                placeholder="个人域名,如 z-library.sk"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                keyboardType="url"
              />
              <TextInput
                style={s.zlInput}
                value={zlUsername}
                onChangeText={setZlUsername}
                placeholder="Z-Library 账号邮箱(可选,配 remix 链接时可留空)"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                keyboardType="email-address"
              />
              <PasswordInput
                style={s.zlInput}
                value={zlPassword}
                onChangeText={setZlPassword}
                placeholder={zlConfig.hasPassword ? "已保存密码,留空不修改" : "密码"}
                placeholderTextColor={colors.mutedForeground}
              />
              <TouchableOpacity style={s.zlSaveBtn} onPress={handleSaveZlib} activeOpacity={0.8}>
                <Text style={s.zlSaveText}>保存 Z-Library 配置</Text>
              </TouchableOpacity>
            </View>
          </View>
          <View style={s.section}>
            <Text style={[s.sectionTitle, { color: colors.mutedForeground }]}>
              阅读器调试
            </Text>
            <View style={[s.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[s.rowTitle, { color: colors.foreground }]}>顶栏背景显示</Text>
                <Text style={[s.rowDesc, { color: colors.mutedForeground }]}>
                  阅读器顶栏(书名条)的卡其背景显示开关,关闭后仅留书名文字。
                </Text>
              </View>
              <Switch
                value={topBarBg}
                onValueChange={(v) => setDevFlag("readerTopBarBackground", v)}
                trackColor={{ true: colors.primary }}
              />
            </View>
            <View style={[s.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[s.rowTitle, { color: colors.foreground }]}>底栏背景显示</Text>
                <Text style={[s.rowDesc, { color: colors.mutedForeground }]}>
                  阅读器底栏(电量/时间/章节/进度条)的卡其背景显示开关,关闭后仅留信息文字。
                </Text>
              </View>
              <Switch
                value={bottomBarBg}
                onValueChange={(v) => setDevFlag("readerBottomBarBackground", v)}
                trackColor={{ true: colors.primary }}
              />
            </View>
          </View>
          <Text style={[s.note, { color: colors.mutedForeground }]}>仅供开发调试使用,不随正式功能发布。</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: { background: string; border: string; card: string; mutedForeground: string; foreground: string; primary: string; primaryForeground: string }) =>
  StyleSheet.create({
    container: { flex: 1 },
    scroll: { flex: 1 },
    scrollContent: { padding: spacing.lg, paddingBottom: spacing.xl },
    section: { gap: spacing.sm },
    sectionTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.medium },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      padding: spacing.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radius.lg,
    },
    rowTitle: { fontSize: fontSize.md, fontWeight: fontWeight.medium },
    rowDesc: { fontSize: fontSize.xs, marginTop: 4, lineHeight: 17, opacity: 0.85 },
    note: { fontSize: fontSize.xs, textAlign: "center", opacity: 0.7 },
    zlCard: {
      padding: spacing.lg,
      gap: spacing.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radius.lg,
    },
    zlRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.md,
    },
    zlLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.medium, flex: 1 },
    zlInput: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.md,
      paddingHorizontal: 10,
      paddingVertical: 7,
      fontSize: fontSize.sm,
      color: colors.foreground,
    },
    zlSaveBtn: {
      borderRadius: radius.lg,
      backgroundColor: colors.primary,
      alignItems: "center",
      paddingVertical: 8,
    },
    zlSaveText: { fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: colors.primaryForeground },
  });
