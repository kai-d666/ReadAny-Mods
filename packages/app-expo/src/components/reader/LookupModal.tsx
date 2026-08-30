/**
 * LookupModal — 内置翻译查词结果弹窗(词 + 释义/翻译)。
 *
 * 长按查词走内置翻译引擎(ai/deepl/microsoft)时展示;外部翻译(词典接口表)拉起第三方词典,不走这里。
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
  word: string;
  loading: boolean;
  result: string | null;
  error: string | null;
  onClose: () => void;
}

export function LookupModal({ visible, word, loading, result, error, onClose }: LookupModalProps) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { t } = useTranslation();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <View style={styles.card} onStartShouldSetResponder={() => true}>
          <Text style={styles.word} numberOfLines={2}>
            {word}
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
