import { CheckIcon, ChevronDownIcon } from "@/components/ui/Icon";
import { useSettingsStore } from "@/stores/settings-store";
import { fontSize as fs, fontWeight as fw, radius, useColors, withOpacity } from "@/styles/theme";
import type { ThemeColors } from "@/styles/theme";
/**
 * ModelSelector — compact pill trigger with popover dropdown.
 * Only lists the models of the currently active endpoint (the endpoint is
 * chosen in Settings → AI → AI Assistant); selecting a model does not change
 * the endpoint. Matches desktop ModelSelector.
 */
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

interface ModelSelectorProps {
  onNavigateToSettings?: () => void;
}

export function ModelSelector({ onNavigateToSettings }: ModelSelectorProps) {
  const [visible, setVisible] = useState(false);
  const [search, setSearch] = useState("");
  const { t } = useTranslation();
  const colors = useColors();
  const s = useMemo(() => makeStyles(colors), [colors]);

  const aiConfig = useSettingsStore((st) => st.aiConfig);
  const setActiveModel = useSettingsStore((st) => st.setActiveModel);

  const activeEndpoint = aiConfig.endpoints.find((e) => e.id === aiConfig.activeEndpointId);
  const models = activeEndpoint?.models ?? [];
  const filteredModels = search.trim()
    ? models.filter((m) => m.toLowerCase().includes(search.toLowerCase()))
    : models;
  const hasActiveModel = aiConfig.activeModel !== "" && models.includes(aiConfig.activeModel);
  const configured = !!activeEndpoint && models.length > 0;
  const canSwitch = configured && models.length > 1;

  const displayName = hasActiveModel
    ? aiConfig.activeModel.length > 20
      ? `${aiConfig.activeModel.slice(0, 18)}...`
      : aiConfig.activeModel
    : t("chat.modelNotConfigured", "未配置");

  const handleSelect = useCallback(
    (model: string) => {
      setActiveModel(model);
      setSearch("");
      setVisible(false);
    },
    [setActiveModel],
  );

  if (aiConfig.endpoints.length === 0) {
    return (
      <TouchableOpacity style={s.trigger} onPress={onNavigateToSettings} activeOpacity={0.7}>
        <Text style={[s.triggerText, { color: colors.amber }]}>
          {t("chat.configureAI", "配置 AI")}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <>
      <TouchableOpacity
        style={s.trigger}
        onPress={() => {
          setSearch("");
          if (canSwitch) setVisible(true);
        }}
        activeOpacity={canSwitch ? 0.7 : 1}
      >
        <Text style={s.triggerText} numberOfLines={1}>
          {displayName}
        </Text>
        {canSwitch && <ChevronDownIcon size={10} color={colors.mutedForeground} />}
      </TouchableOpacity>

      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={() => setVisible(false)}
      >
        <Pressable style={s.backdrop} onPress={() => setVisible(false)}>
          <View style={s.popover}>
            {activeEndpoint && (
              <Text style={s.epName} numberOfLines={1}>
                {activeEndpoint.name || activeEndpoint.baseUrl}
              </Text>
            )}
            <TextInput
              style={s.searchInput}
              includeFontPadding={false} // 防字体 padding 撑高行高
              placeholder={t("settings.ai_searchModels", "搜索模型...")}
              placeholderTextColor={colors.mutedForeground}
              value={search}
              onChangeText={setSearch}
              autoCorrect={false}
              autoCapitalize="none"
            />
            <ScrollView style={s.popoverScroll} showsVerticalScrollIndicator={false}>
              {filteredModels.length === 0 ? (
                <Text style={s.noResults}>
                  {t("settings.ai_noMatchingResults", "无匹配结果")}
                </Text>
              ) : (
                filteredModels.map((model) => {
                  const isActive = model === aiConfig.activeModel;
                  return (
                    <TouchableOpacity
                      key={model}
                      style={[s.modelItem, isActive && s.modelItemActive]}
                      onPress={() => handleSelect(model)}
                      activeOpacity={0.7}
                    >
                      <Text style={[s.modelText, isActive && s.modelTextActive]} numberOfLines={1}>
                        {model}
                      </Text>
                      {isActive && <CheckIcon size={12} color={colors.primary} />}
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    trigger: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      maxWidth: 120,
    },
    triggerText: {
      fontSize: fs.xs,
      color: colors.mutedForeground,
      flexShrink: 1,
    },
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.15)",
      justifyContent: "flex-start",
      alignItems: "flex-end",
      paddingTop: 100,
      paddingRight: 12,
    },
    popover: {
      width: 224,
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      padding: 4,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 8,
      elevation: 8,
    },
    popoverScroll: {
      maxHeight: 288,
    },
    epName: {
      fontSize: 9,
      fontWeight: fw.medium,
      color: colors.mutedForeground,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      paddingHorizontal: 10,
      paddingTop: 8,
      paddingBottom: 2,
    },
    searchInput: {
      height: 28,
      marginHorizontal: 6,
      marginBottom: 4,
      paddingHorizontal: 8,
      paddingVertical: 0, // 防 Android 默认 padding 挤压导致文本上下滚动
      fontSize: fs.xs,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.background,
      color: colors.foreground,
    },
    noResults: {
      paddingVertical: 10,
      textAlign: "center",
      fontSize: fs.xs,
      color: colors.mutedForeground,
    },
    modelItem: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: radius.md,
    },
    modelItemActive: {
      backgroundColor: withOpacity(colors.primary, 0.08),
    },
    modelText: {
      fontSize: fs.xs,
      color: colors.foreground,
      flex: 1,
    },
    modelTextActive: {
      color: colors.primary,
      fontWeight: fw.medium,
    },
  });
