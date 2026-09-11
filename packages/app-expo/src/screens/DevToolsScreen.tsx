/**
 * DevToolsScreen — 开发者模式(隐藏入口:长按底部导航「我的」5s 振动进入)。
 *
 * 目前提供:启动动画开关(关闭 = 跳过 AnimatedSplash,启动直达书架)。
 * 开发者工具页,文案直接中文,不接 i18n;开关持久化在 settings-store devFlags。
 */
import { useDriverConfigStore } from "@readany/core/sources/driver/driver-config-store";
import { ZlibDriver } from "@readany/core/sources/driver/zlib";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { SettingsHeader } from "@/screens/settings/SettingsHeader";
import { useSettingsStore } from "@/stores";
import { useTheme } from "@/styles/ThemeContext";
import { fontSize, fontWeight, radius, spacing } from "@/styles/theme";
import { useEffect, useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
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
  const [zlTesting, setZlTesting] = useState(false);
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
  /** 测试连接:用当前输入(未保存也行)跑 登录→最热,直接给出可用性结论 */
  const handleTestZlib = () => {
    setZlTesting(true);
    void (async () => {
      try {
        const password =
          zlPassword || (await useDriverConfigStore.getState().getZlibPassword());
        const driver = new ZlibDriver({
          domain: zlDomain.trim(),
          username: zlUsername.trim(),
          password,
        });
        const result = await driver.testConnection();
        Alert.alert(
          "测试连接",
          `登录成功 ✓\n镜像:${result.base}\n最热列表:${result.books} 本`,
        );
      } catch (err) {
        Alert.alert("测试连接失败", err instanceof Error ? err.message : String(err));
      } finally {
        setZlTesting(false);
      }
    })();
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
                  在本机 127.0.0.1 启动 OPDS 书源服务(LibGen + Z-Library 上游),并自动加入书源列表。仅建议自用。
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
                <Text style={s.zlLabel}>Z-Library 在线书源</Text>
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
                value={zlUsername}
                onChangeText={setZlUsername}
                placeholder="Z-Library 账号邮箱(登录用)"
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
              <TextInput
                style={s.zlInput}
                value={zlDomain}
                onChangeText={setZlDomain}
                placeholder="镜像域名(可选,留空自动探测可用镜像)"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                keyboardType="url"
              />
              <Text style={[s.zlHint, { color: colors.mutedForeground }]}>
                邮箱 + 密码为主路径(镜像自动探测);想固定某个镜像时再填域名。
              </Text>
              {/* (原"专属链接"输入已移除:邮箱登录为主路径;旧专属链接仅在无密码时作代码层兜底) */}
              <TouchableOpacity style={s.zlSaveBtn} onPress={handleSaveZlib} activeOpacity={0.8}>
                <Text style={s.zlSaveText}>保存 Z-Library 配置</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.zlTestBtn, { borderColor: colors.border }, zlTesting && { opacity: 0.6 }]}
                onPress={handleTestZlib}
                activeOpacity={0.8}
                disabled={zlTesting}
              >
                <Text style={[s.zlTestText, { color: colors.primary }]}>
                  {zlTesting ? "测试中…" : "测试连接(登录 + 拉取最热)"}
                </Text>
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
    zlHint: { fontSize: fontSize.xs, lineHeight: 16 },
    zlTestBtn: {
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: "center",
      paddingVertical: 8,
    },
    zlTestText: { fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  });
