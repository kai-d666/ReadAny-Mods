/**
 * SelectRow — RN 版下拉选择:触发按钮(当前值 + ▾)+ 居中 Modal 单列列表(选中 ✓)。
 * 等价 win 的 Select(button + popover);移动端用 Modal 呈现。
 * 翻译引擎/查词方案等单选项共用。
 */
import { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import {
  fontSize,
  fontWeight,
  radius,
  spacing,
  type ThemeColors,
  useColors,
} from "../../styles/theme";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectRowProps {
  options: SelectOption[];
  value?: string;
  onSelect: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Modal 列表最大高度 */
  maxHeight?: number;
}

export function SelectRow({
  options,
  value,
  onSelect,
  placeholder,
  disabled,
  maxHeight = 380,
}: SelectRowProps) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <>
      <TouchableOpacity
        style={[styles.trigger, disabled && styles.disabled]}
        onPress={() => !disabled && setOpen(true)}
        activeOpacity={0.7}
        disabled={disabled}
      >
        <Text style={styles.triggerText} numberOfLines={1}>
          {current?.label ?? placeholder ?? ""}
        </Text>
        <Text style={styles.chevron}>▾</Text>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={styles.card} onStartShouldSetResponder={() => true}>
            <ScrollView style={{ maxHeight }}>
              {options.map((opt) => (
                <TouchableOpacity
                  key={opt.value}
                  style={styles.item}
                  onPress={() => {
                    onSelect(opt.value);
                    setOpen(false);
                  }}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[styles.itemText, opt.value === value && styles.itemTextActive]}
                    numberOfLines={2}
                  >
                    {opt.label}
                  </Text>
                  {opt.value === value && <Text style={styles.check}>✓</Text>}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    trigger: {
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
    item: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.lg,
      paddingVertical: 13,
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
    check: {
      fontSize: 14,
      color: colors.primary,
      marginLeft: 8,
    },
  });
