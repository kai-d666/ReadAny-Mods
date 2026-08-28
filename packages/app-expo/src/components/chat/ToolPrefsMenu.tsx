import { getModeChoiceTools } from "@readany/core/ai/tools";
import type { AIChatMode } from "@readany/core/types";
/**
 * ToolPrefsMenu — minimal chooser for per-mode choice-item tools (batch 3).
 * Trigger sits in the ChatInput action bar; popover lists ONLY the choice
 * items of the CURRENT mode (always-on and forbidden tools never appear).
 * Full settings UI is a later redesign — this exists to make the mechanism
 * testable on device.
 */
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { WrenchIcon } from "@/components/ui/Icon";
import { useSettingsStore } from "@/stores/settings-store";
import { fontSize as fs, radius, useColors, useTheme, withOpacity } from "@/styles/theme";
import type { ThemeColors } from "@/styles/theme";

export function ToolPrefsMenu({ chatMode }: { chatMode: AIChatMode }) {
  const { t } = useTranslation();
  const colors = useColors();
  const { isDark } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [visible, setVisible] = useState(false);
  const aiConfig = useSettingsStore((st) => st.aiConfig);
  const updateAIConfig = useSettingsStore((st) => st.updateAIConfig);

  const mode = chatMode === "lite" ? "lite" : chatMode === "knowledge" ? "knowledge" : null;
  const items = mode ? getModeChoiceTools(mode) : [];
  const enabled = mode ? aiConfig.toolPrefs?.[mode] ?? [] : [];

  const toggle = useCallback(
    (name: string, on: boolean) => {
      if (!mode) return;
      const updateAIConfigStore = useSettingsStore.getState().updateAIConfig;
      const prefs = { ...aiConfig.toolPrefs };
      const list = [...(prefs[mode] ?? [])];
      const next = on ? [...list.filter((n) => n !== name), name] : list.filter((n) => n !== name);
      prefs[mode] = next;
      updateAIConfigStore({ toolPrefs: prefs });
    },
    [aiConfig.toolPrefs, mode],
  );

  // Standard mode has no choice items — nothing to configure here.
  if (!mode) return null;
  if (items.length === 0) return null;

  return (
    <>
      <TouchableOpacity
        style={[s.trigger, aiConfig.toolPrefs?.[mode]?.length ? s.triggerActive : null]}
        onPress={() => setVisible(true)}
        activeOpacity={0.7}
        accessibilityLabel={t("chat.toolPrefs", "工具开关")}
      >
        <WrenchIcon size={13} color={colors.mutedForeground} />
        <Text style={s.triggerText}>{t("chat.toolPrefs", "工具")}</Text>
      </TouchableOpacity>

      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
        <Pressable style={s.backdrop} onPress={() => setVisible(false)}>
          <View style={s.popover}>
            <Text style={s.title}>
              {t("chat.toolPrefsTitle", "工具开关")} — {chatMode.toUpperCase()}
            </Text>
            <Text style={s.subtitle}>{t("chat.toolPrefsSubtitle", "仅列出当前模式可选的工具")}</Text>
            <ScrollView style={s.list} bounces={false}>
              {items.map((name) => (
                <View key={name} style={s.row}>
                  <Text style={s.rowText} numberOfLines={1}>
                    {name}
                  </Text>
                  <Switch
                    value={enabled.includes(name)}
                    onValueChange={(v) => toggle(name, v)}
                    trackColor={{
                      false: colors.border,
                      true: withOpacity(colors.primary, 0.6),
                    }}
                    thumbColor={isDark ? colors.foreground : colors.background}
                  />
                </View>
              ))}
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
      borderRadius: radius.md,
      opacity: 0.75,
    },
    triggerActive: {
      opacity: 1,
      backgroundColor: withOpacity(colors.primary, 0.08),
    },
    triggerText: {
      fontSize: fs.xs,
      color: colors.mutedForeground,
    },
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.35)",
      justifyContent: "center",
      paddingHorizontal: 32,
    },
    popover: {
      borderRadius: radius.lg,
      backgroundColor: colors.card,
      padding: 14,
      maxHeight: 420,
    },
    title: {
      fontSize: fs.sm,
      fontWeight: "600",
      color: colors.foreground,
      marginBottom: 2,
    },
    subtitle: {
      fontSize: fs.xs,
      color: colors.mutedForeground,
      marginBottom: 8,
    },
    list: {
      flexGrow: 0,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 7,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    rowText: {
      flex: 1,
      fontSize: fs.xs,
      color: colors.foreground,
      marginRight: 8,
    },
  });
