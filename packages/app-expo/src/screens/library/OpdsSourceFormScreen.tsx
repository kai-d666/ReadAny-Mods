/**
 * OPDS 书源添加/编辑表单(2026-09-06):
 * 名称/目录地址(必填)+ 可选 Basic 认证(用户名/密码)+ 允许不安全连接 + 测试连接。
 * UI 模板:settings/sync/WebDavForm + sync-styles;编辑态密码留空 = 保持原密码。
 */
import { ChevronLeftIcon } from "@/components/ui/Icon";
import { PasswordInput } from "@/components/ui/PasswordInput";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import {
  fontSize,
  fontWeight,
  radius,
  spacing,
  useColors,
} from "@/styles/theme";
import { OpdsClient } from "@readany/core/sources/opds-client";
import { useOpdsSourcesStore } from "@readany/core/sources/opds-source-store";
import { generateId } from "@readany/core/utils/generate-id";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Props = NativeStackScreenProps<RootStackParamList, "OpdsSourceForm">;

export function OpdsSourceFormScreen({ navigation, route }: Props) {
  const { t } = useTranslation();
  const colors = useColors();
  const existingId = route.params?.sourceId;

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [allowInsecure, setAllowInsecure] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  const [testError, setTestError] = useState("");
  const [saving, setSaving] = useState(false);

  // 编辑态:加载既有书源回填(密码通常只显示"已保存"提示,不回读)
  useEffect(() => {
    if (!existingId) return;
    void (async () => {
      await useOpdsSourcesStore.getState().hydrate();
      const stored = useOpdsSourcesStore.getState().getSource(existingId);
      if (!stored) return;
      setName(stored.name);
      setUrl(stored.url);
      setUsername(stored.username ?? "");
      setAllowInsecure(stored.allowInsecure ?? false);
      setPasswordSaved(!!stored.hasPassword);
    })();
  }, [existingId]);

  // 测试连接(密码留空时使用已保存密码)
  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    setTestError("");
    try {
      const id = existingId ?? "test";
      const storedPassword =
        password !== "" ? password : await useOpdsSourcesStore.getState().getPassword(id);
      const client = new OpdsClient(
        {
          id,
          name: name.trim() || "test",
          url: url.trim(),
          username: username.trim(),
          allowInsecure,
        },
        storedPassword,
      );
      const feed = await client.testConnection();
      setTestResult("success");
      // 名称留空时自动采用目录标题
      if (!name.trim() && feed.title) setName(feed.title);
    } catch (err) {
      setTestResult("error");
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }, [existingId, name, url, username, password, allowInsecure]);

  const handleSave = useCallback(async () => {
    if (!name.trim() || !url.trim()) {
      Alert.alert(t("library.opdsSaveRequired", "请填写名称和目录地址"));
      return;
    }
    setSaving(true);
    try {
      const id = existingId ?? generateId();
      await useOpdsSourcesStore.getState().saveSource(
        {
          id,
          name: name.trim(),
          url: url.trim(),
          username: username.trim(),
          allowInsecure,
        },
        password,
      );
      navigation.goBack();
    } catch (err) {
      setSaving(false);
      Alert.alert(t("common.failed", "失败"), err instanceof Error ? err.message : String(err));
    }
  }, [existingId, name, url, username, password, allowInsecure, navigation, t]);

  const s = makeStyles(colors);
  const canTest = !testing && url.trim() !== "";

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <View style={s.headerInner}>
          <View style={s.headerRow}>
            <TouchableOpacity style={s.navBtn} onPress={() => navigation.goBack()} activeOpacity={0.8}>
              <ChevronLeftIcon size={18} color={colors.foreground} />
            </TouchableOpacity>
            <View style={s.headerText}>
              <Text style={s.title}>
                {existingId ? t("library.opdsEditSource", "编辑书源") : t("library.opdsAddSource", "添加书源")}
              </Text>
            </View>
          </View>
        </View>
      </View>

      <KeyboardAvoidingView
        style={s.keyboardView}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
          <View style={s.card}>
            <View style={s.fieldGroup}>
              <Text style={s.fieldLabel}>{t("library.opdsName", "书源名称")}</Text>
              <TextInput
                style={s.input}
                value={name}
                onChangeText={setName}
                placeholder={t("library.opdsNamePlaceholder", "古登堡计划")}
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            <View style={s.fieldGroup}>
              <Text style={s.fieldLabel}>{t("library.opdsSourceUrl", "目录地址")}</Text>
              <TextInput
                style={s.input}
                value={url}
                onChangeText={setUrl}
                placeholder={t("library.opdsSourceUrlPlaceholder", "https://www.gutenberg.org/ebooks.opds/")}
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                keyboardType="url"
              />
            </View>

            <View style={s.fieldGroup}>
              <Text style={s.fieldLabel}>{t("library.opdsUsername", "用户名（可选）")}</Text>
              <TextInput
                style={s.input}
                value={username}
                onChangeText={setUsername}
                placeholder={t("library.opdsUsername", "用户名（可选）")}
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
              />
            </View>

            <View style={s.fieldGroup}>
              <Text style={s.fieldLabel}>{t("library.opdsPassword", "密码（可选，留空则匿名）")}</Text>
              <PasswordInput
                style={s.input}
                value={password}
                onChangeText={setPassword}
                placeholder={t("library.opdsPassword", "密码（可选，留空则匿名）")}
                placeholderTextColor={colors.mutedForeground}
              />
              {passwordSaved && (
                <Text style={s.fieldHint}>{t("library.opdsPasswordHint", "已保存密码，留空表示不修改")}</Text>
              )}
            </View>

            <View style={s.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.switchLabel}>{t("library.opdsAllowInsecure", "允许不安全连接（http 明文/自签证书）")}</Text>
              </View>
              <TouchableOpacity
                style={[s.toggle, allowInsecure && s.toggleActive]}
                onPress={() => setAllowInsecure((v) => !v)}
              >
                <View style={[s.toggleThumb, allowInsecure && s.toggleThumbActive]} />
              </TouchableOpacity>
            </View>

            <View style={s.btnRow}>
              <TouchableOpacity
                style={[s.outlineBtn, !canTest && s.btnDisabled]}
                onPress={() => void handleTest()}
                disabled={!canTest}
                activeOpacity={0.7}
              >
                <Text style={s.outlineBtnText}>
                  {testing ? t("library.opdsTesting", "连接中...") : t("library.opdsTestConnection", "测试连接")}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.primaryBtn, (saving || !name.trim() || !url.trim()) && s.btnDisabled]}
                onPress={() => void handleSave()}
                disabled={saving || !name.trim() || !url.trim()}
                activeOpacity={0.7}
              >
                <Text style={s.primaryBtnText}>{t("library.opdsSaveSource", "保存")}</Text>
              </TouchableOpacity>
            </View>

            {testResult === "success" && (
              <Text style={s.successText}>{t("library.opdsTestSuccess", "连接成功，这是一个 OPDS 目录")}</Text>
            )}
            {testResult === "error" && (
              <Text style={s.errorText}>
                {t("library.opdsTestFailed", { defaultValue: "连接失败：{{error}}", error: testError })}
              </Text>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: {
  background: string;
  card: string;
  border: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  primary: string;
  primaryForeground: string;
  emerald: string;
  destructive: string;
}) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    headerInner: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
      paddingBottom: spacing.sm,
      maxWidth: 720,
      width: "100%",
      alignSelf: "center",
    },
    headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    navBtn: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.md,
    },
    headerText: { flex: 1, minWidth: 0 },
    title: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.foreground },
    keyboardView: { flex: 1 },
    scroll: { flex: 1 },
    scrollContent: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.lg,
      paddingBottom: 56,
      maxWidth: 720,
      width: "100%",
      alignSelf: "center",
    },
    card: {
      borderRadius: radius.xl,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: 12,
    },
    fieldGroup: { gap: 6, marginBottom: 12 },
    fieldLabel: {
      fontSize: fontSize.sm,
      fontWeight: fontWeight.medium,
      color: colors.foreground,
    },
    fieldHint: { fontSize: fontSize.xs, color: colors.mutedForeground },
    input: {
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      paddingHorizontal: 12,
      paddingVertical: 8,
      fontSize: fontSize.sm,
      color: colors.foreground,
    },
    switchRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingTop: 12,
    },
    switchLabel: {
      fontSize: fontSize.sm,
      fontWeight: fontWeight.medium,
      color: colors.foreground,
    },
    toggle: {
      width: 44,
      height: 24,
      borderRadius: 12,
      backgroundColor: colors.muted,
      justifyContent: "center",
      padding: 2,
    },
    toggleActive: { backgroundColor: colors.primary },
    toggleThumb: {
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: colors.card,
    },
    toggleThumbActive: { alignSelf: "flex-end" },
    btnRow: { flexDirection: "row", gap: 12, paddingTop: 4 },
    outlineBtn: {
      flex: 1,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: 8,
      alignItems: "center",
    },
    outlineBtnText: {
      fontSize: fontSize.sm,
      fontWeight: fontWeight.medium,
      color: colors.foreground,
    },
    primaryBtn: {
      flex: 1,
      borderRadius: radius.lg,
      backgroundColor: colors.primary,
      paddingVertical: 8,
      alignItems: "center",
    },
    primaryBtnText: {
      fontSize: fontSize.sm,
      fontWeight: fontWeight.medium,
      color: colors.primaryForeground,
    },
    btnDisabled: { opacity: 0.4 },
    successText: { fontSize: fontSize.sm, color: colors.emerald },
    errorText: { fontSize: fontSize.sm, color: colors.destructive },
  });
