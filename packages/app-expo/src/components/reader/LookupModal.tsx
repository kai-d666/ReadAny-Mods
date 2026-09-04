/**
 * LookupModal — 内置翻译结果弹窗(词/文本 + 释义/译文)。
 *
 * 长按查词(dictionary mode)与取词翻译(selection mode)共用;
 * 外部翻译(词典接口表)拉起第三方词典,不走这里。
 * 画面右上角喇叭仅当 onSpeak 传入时显示(查词模式):点击用已配置 TTS 再读一遍。
 */
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Volume2 } from "lucide-react-native";
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
  /** 查词模式提供的"重新发音"回调(selection 模式不传,不显示喇叭) */
  onSpeak?: () => void;
}

export function LookupModal({ visible, title, loading, result, error, onClose, onSpeak }: LookupModalProps) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { t } = useTranslation();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <View style={styles.card} onStartShouldSetResponder={() => true}>
          <View style={styles.wordRow}>
            <Text style={styles.word} numberOfLines={2}>
              {title}
            </Text>
            {onSpeak && (
              <TouchableOpacity
                style={styles.speakBtn}
                onPress={onSpeak}
                hitSlop={10}
                accessibilityLabel={t("translation.lookupSpeak", "朗读")}
              >
                <Volume2 size={18} color={colors.primary} />
              </TouchableOpacity>
            )}
          </View>
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
    wordRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      position: "relative",
    },
    word: {
      fontSize: fontSize.xl,
      fontWeight: fontWeight.semibold,
      color: colors.foreground,
      textAlign: "center",
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.md,
    },
    speakBtn: {
      position: "absolute",
      right: spacing.lg,
      top: 0,
      padding: 4,
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
