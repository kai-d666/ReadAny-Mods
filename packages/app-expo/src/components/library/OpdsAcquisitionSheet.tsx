/**
 * OPDS 多格式选择弹层(2026-09-06):
 * 一个条目有多种可下载格式时弹出,按优先级排序,首位标"推荐"。
 * 样式参照 WebDavImportSourceSheet(居中卡片 Modal)。
 */
import { ChevronRightIcon } from "@/components/ui/Icon";
import {
  fontSize,
  fontWeight,
  radius,
  spacing,
  useColors,
  withOpacity,
} from "@/styles/theme";
import type { OpdsAcquisition, OpdsPublication } from "@readany/core/sources/opds";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";

interface OpdsAcquisitionSheetProps {
  visible: boolean;
  publication: OpdsPublication | null;
  onPick: (acq: OpdsAcquisition) => void;
  onClose: () => void;
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 100 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function OpdsAcquisitionSheet({
  visible,
  publication,
  onPick,
  onClose,
}: OpdsAcquisitionSheetProps) {
  const { t } = useTranslation();
  const colors = useColors();
  const s = makeStyles(colors);

  const acquisitions =
    publication?.acquisitions
      .filter((acq) => acq.priority >= 0)
      .sort((a, b) => a.priority - b.priority) ?? [];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.overlay} onPress={onClose}>
        <Pressable style={s.sheetWrap} onPress={(event) => event.stopPropagation()}>
          <View style={s.sheet}>
            <Text style={s.title} numberOfLines={2}>
              {publication?.title ?? ""}
            </Text>
            <Text style={s.subtitle}>{t("library.opdsPickFormat", "选择下载格式")}</Text>
            {acquisitions.map((acq, index) => (
              <TouchableOpacity
                key={`${acq.extension}-${acq.href}`}
                style={[s.row, index > 0 && s.rowBorder]}
                onPress={() => onPick(acq)}
                activeOpacity={0.8}
              >
                <Text style={s.format}>{acq.extension.toUpperCase()}</Text>
                <Text style={s.size}>{formatBytes(acq.size ?? 0)}</Text>
                {index === 0 && (
                  <View style={s.badge}>
                    <Text style={s.badgeText}>{t("library.opdsRecommended", "推荐")}</Text>
                  </View>
                )}
                <ChevronRightIcon size={16} color={colors.mutedForeground} />
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={s.cancelBtn} onPress={onClose} activeOpacity={0.8}>
              <Text style={s.cancelText}>{t("common.cancel", "取消")}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: {
  background: string;
  card: string;
  border: string;
  foreground: string;
  mutedForeground: string;
  primary: string;
}) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.4)",
      alignItems: "center",
      justifyContent: "center",
      padding: spacing.xl,
    },
    sheetWrap: { width: "100%", maxWidth: 480 },
    sheet: {
      backgroundColor: colors.background,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: withOpacity(colors.border, 0.92),
      padding: spacing.lg,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.18,
      shadowRadius: 14,
      elevation: 8,
    },
    title: {
      fontSize: fontSize.base,
      fontWeight: fontWeight.semibold,
      color: colors.foreground,
    },
    subtitle: {
      fontSize: fontSize.sm,
      color: colors.mutedForeground,
      marginTop: 4,
      marginBottom: 8,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 12,
    },
    rowBorder: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: withOpacity(colors.border, 0.8),
    },
    format: {
      fontSize: fontSize.sm,
      fontWeight: fontWeight.semibold,
      color: colors.foreground,
      minWidth: 56,
    },
    size: { fontSize: fontSize.xs, color: colors.mutedForeground, flex: 1 },
    badge: {
      borderRadius: radius.sm,
      backgroundColor: withOpacity(colors.primary, 0.12),
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    badgeText: { fontSize: fontSize.xs, color: colors.primary, fontWeight: fontWeight.medium },
    cancelBtn: {
      marginTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: withOpacity(colors.border, 0.8),
      paddingTop: 12,
      alignItems: "center",
    },
    cancelText: { fontSize: fontSize.sm, color: colors.mutedForeground },
  });
