/**
 * OPDS 书源管理列表(2026-09-06):
 * 列出已配置书源,提供 添加/编辑/删除/进入目录。
 * UI 模板:WebDavImportBrowserScreen 自绘头部 + 空态;数据:useOpdsSourcesStore。
 */
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  EditIcon,
  GlobeIcon,
  PlusIcon,
  Trash2Icon,
} from "@/components/ui/Icon";
import type { RootStackParamList } from "@/navigation/RootNavigator";
import {
  fontSize,
  fontWeight,
  radius,
  spacing,
  useColors,
  withOpacity,
} from "@/styles/theme";
import { useOpdsSourcesStore } from "@readany/core/sources/opds-source-store";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Props = NativeStackScreenProps<RootStackParamList, "OpdsSources">;

export function OpdsSourcesScreen({ navigation }: Props) {
  const { t } = useTranslation();
  const colors = useColors();
  const sources = useOpdsSourcesStore((s) => s.sources);
  const loaded = useOpdsSourcesStore((s) => s.loaded);

  useEffect(() => {
    void useOpdsSourcesStore.getState().hydrate();
  }, []);

  const handleDelete = useCallback(
    (id: string, name: string) => {
      Alert.alert(
        t("library.opdsDeleteSource", "删除书源"),
        t("library.opdsDeleteConfirm", {
          defaultValue: "确定删除「{{name}}」？凭据会一并清除。",
          name,
        }),
        [
          { text: t("common.cancel", "取消"), style: "cancel" },
          {
            text: t("library.opdsDeleteSource", "删除书源"),
            style: "destructive",
            onPress: () => void useOpdsSourcesStore.getState().removeSource(id),
          },
        ],
      );
    },
    [t],
  );

  const s = makeStyles(colors);

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <View style={s.headerInner}>
          <View style={s.headerRow}>
            <TouchableOpacity style={s.navBtn} onPress={() => navigation.goBack()} activeOpacity={0.8}>
              <ChevronLeftIcon size={18} color={colors.foreground} />
            </TouchableOpacity>
            <View style={s.headerText}>
              <Text style={s.title}>{t("library.opdsManageTitle", "书源管理")}</Text>
              <Text style={s.subtitle} numberOfLines={1}>
                {t("library.opdsSourcesTitle", "OPDS 书源")}
              </Text>
            </View>
            <TouchableOpacity
              style={s.navBtn}
              onPress={() => navigation.navigate("OpdsSourceForm", {})}
              activeOpacity={0.8}
              accessibilityLabel={t("library.opdsAddSource", "添加书源")}
            >
              <PlusIcon size={18} color={colors.primary} />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {!loaded ? null : sources.length === 0 ? (
        <View style={s.stateWrap}>
          <GlobeIcon size={28} color={colors.mutedForeground} />
          <Text style={s.stateTitle}>{t("library.opdsListEmptyTitle", "还没有 OPDS 书源")}</Text>
          <Text style={s.stateDesc}>{t("library.opdsListEmptyDesc", "添加一个在线目录（如古登堡计划、Calibre 书库），就能在 App 里浏览、搜索并下载书籍。")}</Text>
          <TouchableOpacity
            style={s.primaryBtn}
            onPress={() => navigation.navigate("OpdsSourceForm", {})}
            activeOpacity={0.85}
          >
            <Text style={s.primaryBtnText}>{t("library.opdsAddSource", "添加书源")}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={sources}
          keyExtractor={(source) => source.id}
          contentContainerStyle={s.listContent}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={s.entryCard}
              onPress={() => navigation.navigate("OpdsCatalog", { sourceId: item.id })}
              activeOpacity={0.85}
            >
              <View style={s.entryIconWrap}>
                <GlobeIcon size={18} color={colors.primary} />
              </View>
              <View style={s.entryText}>
                <Text style={s.entryTitle} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={s.entryMeta} numberOfLines={1}>
                  {item.url}
                </Text>
                {item.username ? (
                  <Text style={s.entryUser} numberOfLines={1}>
                    {item.username}
                  </Text>
                ) : null}
              </View>
              <TouchableOpacity
                style={s.actionBtn}
                onPress={() => navigation.navigate("OpdsSourceForm", { sourceId: item.id })}
                activeOpacity={0.7}
                accessibilityLabel={t("library.opdsEditSource", "编辑书源")}
              >
                <EditIcon size={16} color={colors.mutedForeground} />
              </TouchableOpacity>
              <TouchableOpacity
                style={s.actionBtn}
                onPress={() => handleDelete(item.id, item.name)}
                activeOpacity={0.7}
                accessibilityLabel={t("library.opdsDeleteSource", "删除书源")}
              >
                <Trash2Icon size={16} color={colors.destructive} />
              </TouchableOpacity>
              <ChevronRightIcon size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const makeStyles = (colors: {
  background: string;
  card: string;
  border: string;
  foreground: string;
  mutedForeground: string;
  primary: string;
  primaryForeground: string;
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
    subtitle: { fontSize: fontSize.xs, color: colors.mutedForeground, marginTop: 2 },
    stateWrap: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      paddingHorizontal: spacing.xl,
    },
    stateTitle: { fontSize: fontSize.base, fontWeight: fontWeight.medium, color: colors.foreground },
    stateDesc: {
      fontSize: fontSize.sm,
      color: colors.mutedForeground,
      textAlign: "center",
      lineHeight: 20,
    },
    primaryBtn: {
      borderRadius: radius.lg,
      backgroundColor: colors.primary,
      paddingHorizontal: 20,
      paddingVertical: 10,
      marginTop: 8,
    },
    primaryBtnText: {
      fontSize: fontSize.sm,
      fontWeight: fontWeight.medium,
      color: colors.primaryForeground,
    },
    listContent: { padding: spacing.md, gap: spacing.sm },
    entryCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: colors.card,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
    },
    entryIconWrap: {
      width: 34,
      height: 34,
      borderRadius: radius.md,
      backgroundColor: withOpacity(colors.primary, 0.12),
      alignItems: "center",
      justifyContent: "center",
    },
    entryText: { flex: 1, minWidth: 0 },
    entryTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.foreground },
    entryMeta: { fontSize: fontSize.xs, color: colors.mutedForeground, marginTop: 2 },
    entryUser: { fontSize: fontSize.xs, color: colors.mutedForeground, marginTop: 2, opacity: 0.8 },
    actionBtn: { padding: 6 },
  });
