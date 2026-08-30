/**
 * TranslationModelPicker — 移动版 win TranslationModelSelector:
 * 端点下拉(SelectRow)+ 模型选择(带搜索框的 Modal),写 AIModelSelection(endpointId + model)。
 * 取词翻译(selectionModel)/ 长按翻译(dictionaryModel)各一个实例、独立配置。
 */
import { SelectRow } from "@/components/ui/SelectRow";
import { useSettingsStore } from "@/stores";
import type { AIModelSelection } from "@readany/core/types/translation";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  fontSize,
  fontWeight,
  radius,
  spacing,
  type ThemeColors,
  useColors,
} from "../../styles/theme";

interface TranslationModelPickerProps {
  value?: AIModelSelection;
  onChange: (selection: AIModelSelection) => void;
}

export function TranslationModelPicker({ value, onChange }: TranslationModelPickerProps) {
  const { t } = useTranslation();
  const colors = useColors();
  const styles = makeStyles(colors);
  const aiConfig = useSettingsStore((s) => s.aiConfig);
  const endpoints = aiConfig.endpoints;

  // 优先展示已存的端点;被删除时回退第一个(仅展示,新选择会把有效端点写回)
  const storedEndpoint = endpoints.find((e) => e.id === value?.endpointId);
  const displayEndpoint = storedEndpoint ?? endpoints[0];
  const models = displayEndpoint?.models ?? [];

  const [modelOpen, setModelOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? models.filter((m) => m.toLowerCase().includes(query.trim().toLowerCase()))
    : models;

  const modelPlaceholder =
    endpoints.length === 0
      ? t("settings.ai_noEndpoints", "暂无端点")
      : models.length === 0
        ? t("settings.noModelsFetched", "未获取到模型")
        : value?.model || "";

  return (
    <View>
      <Text style={styles.label}>{t("settings.translationEndpoint", "端点")}</Text>
      <SelectRow
        options={endpoints.map((ep) => ({ value: ep.id, label: ep.name || ep.baseUrl }))}
        value={displayEndpoint?.id}
        onSelect={(id) => onChange({ endpointId: id, model: "" })}
        placeholder={t("settings.ai_selectEndpoint", "选择端点")}
        disabled={endpoints.length === 0}
      />

      <Text style={[styles.label, styles.labelSpaced]}>{t("settings.model", "模型")}</Text>
      <TouchableOpacity
        style={[styles.modelTrigger, models.length === 0 && styles.disabled]}
        onPress={() => {
          setQuery("");
          if (models.length > 0) setModelOpen(true);
        }}
        activeOpacity={0.7}
      >
        <Text style={styles.triggerText} numberOfLines={1}>
          {modelPlaceholder}
        </Text>
        <Text style={styles.chevron}>▾</Text>
      </TouchableOpacity>

      <Modal visible={modelOpen} transparent animationType="fade" onRequestClose={() => setModelOpen(false)}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setModelOpen(false)}>
          <View style={styles.card} onStartShouldSetResponder={() => true}>
            <Text style={styles.cardTitle}>{t("settings.selectModel", "选择模型")}</Text>
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder={t("settings.ai_searchModels", "搜索模型...")}
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <ScrollView style={{ maxHeight: 320 }}>
              {filtered.length === 0 ? (
                <Text style={styles.emptyHint}>{t("settings.ai_noMatchingResults", "没有匹配的模型")}</Text>
              ) : (
                filtered.map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={styles.item}
                    onPress={() => {
                      onChange({ endpointId: displayEndpoint.id, model: m });
                      setModelOpen(false);
                    }}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[styles.itemText, m === value?.model && styles.itemTextActive]}
                      numberOfLines={1}
                    >
                      {m}
                    </Text>
                    {m === value?.model && <Text style={styles.check}>✓</Text>}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    label: {
      fontSize: fontSize.sm,
      color: colors.mutedForeground,
      marginBottom: 6,
    },
    labelSpaced: {
      marginTop: 12,
    },
    modelTrigger: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      paddingHorizontal: spacing.lg,
      paddingVertical: 12,
    },
    disabled: {
      opacity: 0.5,
    },
    triggerText: {
      flex: 1,
      fontSize: fontSize.sm,
      color: colors.foreground,
    },
    chevron: {
      fontSize: 14,
      color: colors.mutedForeground,
      marginLeft: 8,
    },
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.4)",
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: spacing.xl,
    },
    card: {
      width: "100%",
      maxWidth: 340,
      backgroundColor: colors.background,
      borderRadius: radius.xl,
      overflow: "hidden",
    },
    cardTitle: {
      fontSize: fontSize.base,
      fontWeight: fontWeight.semibold,
      color: colors.foreground,
      textAlign: "center",
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    searchInput: {
      marginHorizontal: spacing.lg,
      marginVertical: 10,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      paddingHorizontal: spacing.lg,
      paddingVertical: 8,
      fontSize: fontSize.sm,
      color: colors.foreground,
    },
    item: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.lg,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    itemText: {
      flex: 1,
      fontSize: fontSize.sm,
      color: colors.foreground,
    },
    itemTextActive: {
      color: colors.primary,
      fontWeight: fontWeight.medium,
    },
    emptyHint: {
      fontSize: fontSize.sm,
      color: colors.mutedForeground,
      textAlign: "center",
      paddingVertical: 20,
    },
    check: {
      fontSize: 14,
      color: colors.primary,
      marginLeft: 8,
    },
  });
