/**
 * LookupModal — 内置翻译结果弹窗(词/文本 + 释义/译文)。
 *
 * 长按查词(dictionary mode)与取词翻译(selection mode)共用;
 * 外部翻译(词典接口表)拉起第三方词典,不走这里。
 * TODO(待办):弹窗顶部加目标语言切换(照 win TranslationPopover 头部)。
 */
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  fontSize,
  fontWeight,
  radius,
  spacing,
  type ThemeColors,
  useColors,
} from "../../styles/theme";

interface LookupModalProps {
  visible: boolean;
  /** 结果标题:查词=单词,取词=选中文本 */
  title: string;
  loading: boolean;
  result: string | null;
  error: string | null;
  onClose: () => void;
}

export function LookupModal({ visible, title, loading, result, error, onClose }: LookupModalProps) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { t } = useTranslation();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <View style={styles.card} onStartShouldSetResponder={() => true}>
          <Text style={styles.word} numberOfLines={2}>
            {title}
          </Text>
          <View style={styles.divider} />
          {loading ? (
            <View style={styles.centerBox}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.stateText}>{t("translation.lookupLoading", "查词中...")}</Text>
            </View>
          ) : error ? (
            <Text style={styles.stateText}>{error}</Text>
          ) : result ? (
            <Text style={styles.result} selectable>
              {result}
            </Text>
          ) : (
            <Text style={styles.stateText}>{t("translation.lookupNoResult", "没有查词结果")}</Text>
          )}
          <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.closeText}>{t("common.close", "关闭")}</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.4)",
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: spacing.xl,
    },
    card: {
      width: "100%",
      maxWidth: 420,
      maxHeight: "70%",
      backgroundColor: colors.background,
      borderRadius: radius.xl,
      paddingVertical: spacing.lg,
      overflow: "hidden",
    },
    word: {
      fontSize: fontSize.xl,
      fontWeight: fontWeight.semibold,
      color: colors.foreground,
      textAlign: "center",
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.md,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
    },
    centerBox: {
      alignItems: "center",
      gap: 10,
      paddingVertical: spacing.xl,
      paddingHorizontal: spacing.lg,
    },
    result: {
      fontSize: fontSize.md,
      lineHeight: 24,
      color: colors.foreground,
      paddingVertical: spacing.lg,
      paddingHorizontal: spacing.lg,
    },
    stateText: {
      fontSize: fontSize.sm,
      color: colors.mutedForeground,
      textAlign: "center",
      paddingVertical: spacing.xl,
      paddingHorizontal: spacing.lg,
    },
    closeBtn: {
      alignItems: "center",
      paddingVertical: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    closeText: {
      fontSize: fontSize.md,
      color: colors.primary,
      fontWeight: fontWeight.medium,
    },
  });
