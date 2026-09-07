/**
 * InfoTip — 小问号图标,点击弹出提示文本小窗(轻量 Modal)。
 * 收敛"解释说明类"文本:界面只留字段本体,说明收进问号弹窗(2026-09-07 用户方案)。
 */
import { useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import {
  type ThemeColors,
  fontSize,
  fontWeight,
  radius,
  spacing,
  useColors,
} from "../../styles/theme";
import { HelpCircleIcon, XIcon } from "./Icon";

export function InfoTip({
  text,
  title,
  children,
  size = 15,
}: {
  /** 纯文本说明(children 为空时渲染) */
  text?: string;
  title?: string;
  /** 自定义内容(可放复制按钮/功能元件等交互) */
  children?: ReactNode;
  size?: number;
}) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [open, setOpen] = useState(false);

  return (
    <>
      <TouchableOpacity
        onPress={() => setOpen(true)}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        activeOpacity={0.7}
      >
        <HelpCircleIcon size={size} color={colors.mutedForeground} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.overlay} onPress={() => setOpen(false)}>
          {/* onStartShouldSetResponder:阻止点击卡片内透传到遮罩关闭(同 SelectRow 模式) */}
          <View style={styles.card} onStartShouldSetResponder={() => true}>
            <View style={styles.header}>
              {title ? <Text style={styles.title}>{title}</Text> : <View />}
              <TouchableOpacity
                onPress={() => setOpen(false)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.7}
              >
                <XIcon size={14} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
            {children ?? (text ? <Text style={styles.body}>{text}</Text> : null)}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.4)",
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: 32,
    },
    card: {
      width: "100%",
      maxWidth: 320,
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      padding: spacing.lg,
      gap: spacing.sm,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.sm,
    },
    title: {
      flex: 1,
      fontSize: fontSize.base,
      fontWeight: fontWeight.semibold,
      color: colors.foreground,
    },
    body: {
      fontSize: fontSize.sm,
      lineHeight: 20,
      color: colors.mutedForeground,
    },
  });
