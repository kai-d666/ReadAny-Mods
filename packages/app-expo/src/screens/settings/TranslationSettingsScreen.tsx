import { KeyboardAwareScrollView } from "@/components/ui/KeyboardAwareScrollView";
import {
  DICTIONARY_OPTIONS,
  getDictionaryOption,
} from "@/lib/dictionary-intents";
import { useResponsiveLayout } from "@/hooks/use-responsive-layout";
import { useSettingsStore } from "@/stores";
import {
  TRANSLATOR_PROVIDERS,
  type DictionaryMethod,
  type TranslatorName,
} from "@readany/core/types/translation";
import { DEFAULT_DICTIONARY_PROMPT } from "@readany/core/translation/providers";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PasswordInput } from "../../components/ui/PasswordInput";
import { SelectRow, type SelectOption } from "../../components/ui/SelectRow";
import { LocalDictDownloadCard } from "../../components/settings/LocalDictDownloadCard";
import { TranslationModelPicker } from "../../components/settings/TranslationModelPicker";
import {
  type ThemeColors,
  fontSize,
  fontWeight,
  radius,
  spacing,
  useColors,
} from "../../styles/theme";
import { SettingsHeader } from "./SettingsHeader";

/**
 * 翻译设置 — 排版对齐 win(桌面)版:
 * 翻译引擎下拉(win 三引擎 + 移动端「外部翻译」)→
 *   AI:取词翻译 / 长按翻译 两个独立子卡(dictionaryMethod 分支:AI 查词 / 本地词典 ECDICT)
 *   DeepL:API Key + baseUrl
 *   外部翻译:词典接口表(移动端独有,按原先样式展开)
 */
export default function TranslationSettingsScreen() {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { t } = useTranslation();
  const layout = useResponsiveLayout();
  const { translationConfig, updateTranslationConfig, aiConfig } = useSettingsStore();

  const isAIProvider = translationConfig.provider.id === "ai";
  const isDeepLProvider = translationConfig.provider.id === "deepl";
  const isExternalProvider = translationConfig.provider.id === "external";

  const providerOptions: SelectOption[] = [
    ...TRANSLATOR_PROVIDERS.map((p) => ({ value: p.id, label: t(p.labelKey) })),
    { value: "external", label: t("translation.providerExternal", "外部翻译") },
  ];

  const handleProviderChange = (providerId: TranslatorName) => {
    updateTranslationConfig({
      provider: {
        ...translationConfig.provider,
        id: providerId,
        name:
          providerId === "external"
            ? "translation.providerExternal"
            : TRANSLATOR_PROVIDERS.find((p) => p.id === providerId)?.labelKey || "",
      },
    });
  };

  const dictionaryMethod = translationConfig.dictionaryMethod ?? "ai";
  const dictionaryOption = getDictionaryOption(translationConfig.dictionaryOptionKey);

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: colors.background }]}
      edges={["top"]}
    >
      <SettingsHeader
        title={t("translation.settingsTitle", "翻译设置")}
        subtitle={t("settings.realtimeHint")}
      />

      <KeyboardAwareScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { alignItems: "center" }]}
      >
          <View style={[styles.contentColumn, { width: "100%", maxWidth: layout.centeredContentWidth }]}>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{t("settings.translation_title", "翻译设置")}</Text>
              <Text style={styles.sectionDesc}>{t("settings.translation_desc", "配置翻译选项")}</Text>

              {/* 翻译引擎(下拉,与 win 同款) */}
              <Text style={styles.fieldLabel}>{t("settings.translationProvider", "翻译引擎")}</Text>
              <SelectRow
                options={providerOptions}
                value={translationConfig.provider.id}
                onSelect={(v) => handleProviderChange(v as TranslatorName)}
              />

              {/* 外部翻译 → 词典接口表(静读天下模型:固定接口 + 系统解析拉起,不扫描) */}
              {isExternalProvider && (
                <View style={[styles.subCard, styles.subCardSpaced]}>
                  <Text style={styles.subCardTitle}>
                    {t("settings.dictionaryOptionTitle", "查词词典")}
                  </Text>
                  {DICTIONARY_OPTIONS.map((opt) => {
                    const selected = opt.key === dictionaryOption.key;
                    return (
                      <TouchableOpacity
                        key={opt.key}
                        style={[
                          styles.dictItem,
                          opt.key !== DICTIONARY_OPTIONS[0].key && styles.dictItemBorder,
                        ]}
                        onPress={() => updateTranslationConfig({ dictionaryOptionKey: opt.key })}
                        activeOpacity={0.7}
                      >
                        <Text style={styles.dictItemText}>{t(opt.labelKey, opt.labelKey)}</Text>
                        {selected && <Text style={styles.check}>✓</Text>}
                      </TouchableOpacity>
                    );
                  })}

                  {/* 自定义在线词典:选 custom 时显示 URL 输入 */}
                  {dictionaryOption.key === "custom" && (
                    <View style={{ marginTop: 12 }}>
                      <Text style={styles.hintText}>
                        {t("settings.dictionaryOptionCustomHint", "填入查询 URL，用 %s 代替查询词")}
                      </Text>
                      <TextInput
                        style={styles.apiKeyInput}
                        value={translationConfig.dictionaryCustomUrl || ""}
                        onChangeText={(v) => updateTranslationConfig({ dictionaryCustomUrl: v })}
                        placeholder="https://www.baidu.com/s?wd=%s"
                        placeholderTextColor={colors.mutedForeground}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                    </View>
                  )}
                </View>
              )}

              {/* AI 引擎 → 取词翻译 / 长按翻译 两个独立子栏(win 排版) */}
              {isAIProvider && (
                <>
                  {/* 取词翻译 */}
                  <View style={[styles.subCard, styles.subCardSpaced]}>
                    <Text style={styles.subCardTitle}>
                      {t("settings.translationSelectionTitle")}
                    </Text>
                    <Text style={styles.subCardDesc}>
                      {t("settings.translationSelectionDesc")}
                    </Text>
                    <TranslationModelPicker
                      value={translationConfig.selectionModel}
                      onChange={(s) => updateTranslationConfig({ selectionModel: s })}
                    />
                    <Text style={styles.hintText}>{t("settings.translationModelUnsetHint")}</Text>
                  </View>

                  {/* 长按翻译(词典查词) */}
                  <View style={[styles.subCard, styles.subCardSpaced]}>
                    <Text style={styles.subCardTitle}>
                      {t("settings.translationDictionaryTitle")}
                    </Text>
                    <Text style={styles.subCardDesc}>
                      {t("settings.translationDictionaryDesc")}
                    </Text>

                    {/* 自动发音开关(全局,两种查词方案都生效) */}
                    <View style={styles.switchRow}>
                      <View style={styles.switchTextWrap}>
                        <Text style={styles.switchLabel}>{t("settings.dictionarySpeak")}</Text>
                        <Text style={styles.hintText}>{t("settings.dictionarySpeakDesc")}</Text>
                      </View>
                      <Switch
                        value={translationConfig.dictionarySpeak ?? false}
                        onValueChange={(v) => updateTranslationConfig({ dictionarySpeak: v })}
                      />
                    </View>

                    {/* 查词方案:AI 查词 / 本地词典 ECDICT */}
                    <Text style={[styles.fieldLabel, styles.subCardSpaced]}>
                      {t("settings.dictionaryMethod")}
                    </Text>
                    <SelectRow
                      options={[
                        { value: "ai", label: t("settings.dictionaryMethodAI") },
                        { value: "ecdict", label: t("settings.dictionaryMethodECDICT") },
                      ]}
                      value={dictionaryMethod}
                      onSelect={(v) =>
                        updateTranslationConfig({ dictionaryMethod: v as DictionaryMethod })
                      }
                    />

                    {dictionaryMethod !== "ai" ? (
                      <View>
                        <Text style={styles.hintText}>
                          {t("settings.dictionaryMethodECDICTHint")}
                        </Text>
                        {/* 非 AI 方案查不到时 AI 兜底开关 */}
                        <View style={styles.switchRow}>
                          <View style={styles.switchTextWrap}>
                            <Text style={styles.switchLabel}>{t("settings.dictionaryFallback")}</Text>
                            <Text style={styles.hintText}>{t("settings.dictionaryFallbackDesc")}</Text>
                          </View>
                          <Switch
                            value={translationConfig.dictionaryFallback !== false}
                            onValueChange={(v) => updateTranslationConfig({ dictionaryFallback: v })}
                          />
                        </View>

                        {/* 本地词典下载中心(精选/全量 + 进度 + 删除) */}
                        <Text style={[styles.fieldLabel, styles.subCardSpaced]}>
                          {t("settings.dictDownloadTitle", "离线词典")}
                        </Text>
                        <LocalDictDownloadCard />
                      </View>
                    ) : (
                      <View>
                        <TranslationModelPicker
                          value={translationConfig.dictionaryModel}
                          onChange={(s) => updateTranslationConfig({ dictionaryModel: s })}
                        />
                        <Text style={styles.hintText}>{t("settings.translationModelUnsetHint")}</Text>

                        {/* 词典查词提示词(仅长按生效) */}
                        <Text style={[styles.fieldLabel, styles.subCardSpaced]}>
                          {t("settings.dictionaryPromptTitle")}
                        </Text>
                        <TextInput
                          style={styles.promptInput}
                          multiline
                          value={translationConfig.dictionaryPrompt ?? ""}
                          placeholder={DEFAULT_DICTIONARY_PROMPT}
                          placeholderTextColor={colors.mutedForeground}
                          onChangeText={(v) => updateTranslationConfig({ dictionaryPrompt: v })}
                          textAlignVertical="top"
                        />
                        <Text style={[styles.hintText, styles.promptRowText]}>
                          {t("settings.dictionaryPromptDesc")}
                        </Text>
                      </View>
                    )}
                  </View>
                </>
              )}

              {/* DeepL API Key(仅 DeepL 引擎) */}
              {isDeepLProvider && (
                <View style={[styles.subCard, styles.subCardSpaced]}>
                  <Text style={styles.subCardTitle}>{t("translation.deeplApiKey")}</Text>
                  <PasswordInput
                    style={styles.apiKeyInput}
                    value={translationConfig.provider.apiKey || ""}
                    onChangeText={(v) =>
                      updateTranslationConfig({
                        provider: {
                          ...translationConfig.provider,
                          apiKey: v,
                        },
                      })
                    }
                    placeholder={t("translation.deeplApiKeyPlaceholder")}
                    placeholderTextColor={colors.mutedForeground}
                  />
                  <Text style={styles.hintText}>{t("settings.deeplKeyHint")}</Text>

                  <Text style={[styles.fieldLabel, styles.subCardSpaced]}>
                    {t("translation.deeplBaseUrl")}
                  </Text>
                  <TextInput
                    style={styles.apiKeyInput}
                    value={translationConfig.provider.baseUrl || ""}
                    onChangeText={(v) =>
                      updateTranslationConfig({
                        provider: {
                          ...translationConfig.provider,
                          baseUrl: v,
                        },
                      })
                    }
                    placeholder={t(
                      "translation.deeplBaseUrlPlaceholder",
                      "https://api-free.deepl.com/v2",
                    )}
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <Text style={styles.hintText}>
                    {t(
                      "translation.deeplBaseUrlHint",
                      "填写基础地址，也支持直接粘贴完整的 /translate 地址。",
                    )}
                  </Text>
                </View>
              )}
            </View>
          </View>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    keyboardView: { flex: 1 },
    scroll: { flex: 1 },
    scrollContent: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.xxl,
      paddingBottom: 56,
      gap: 24,
    },
    contentColumn: {},
    section: {},
    sectionTitle: {
      fontSize: fontSize.base,
      fontWeight: fontWeight.semibold,
      color: colors.foreground,
      marginBottom: 2,
    },
    sectionDesc: {
      fontSize: fontSize.sm,
      color: colors.mutedForeground,
      marginBottom: 16,
      lineHeight: 20,
    },
    fieldLabel: {
      fontSize: fontSize.sm,
      color: colors.mutedForeground,
      marginBottom: 8,
    },
    subCard: {
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      padding: spacing.lg,
    },
    subCardSpaced: {
      marginTop: spacing.lg,
    },
    subCardTitle: {
      fontSize: fontSize.base,
      fontWeight: fontWeight.semibold,
      color: colors.foreground,
      marginBottom: 4,
    },
    subCardDesc: {
      fontSize: fontSize.sm,
      color: colors.mutedForeground,
      marginBottom: 12,
      lineHeight: 20,
    },
    hintText: {
      fontSize: fontSize.sm,
      color: colors.mutedForeground,
      marginTop: 6,
      lineHeight: 20,
    },
    switchRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      marginTop: 12,
    },
    switchTextWrap: {
      flex: 1,
      gap: 2,
    },
    switchLabel: {
      fontSize: fontSize.sm,
      color: colors.foreground,
    },
    dictItem: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 11,
    },
    dictItemBorder: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    dictItemText: {
      fontSize: fontSize.sm,
      color: colors.foreground,
      marginRight: 8,
    },
    check: {
      fontSize: 14,
      color: colors.primary,
    },
    apiKeyInput: {
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      paddingHorizontal: spacing.lg,
      paddingVertical: 12,
      fontSize: fontSize.sm,
      color: colors.foreground,
      marginTop: 8,
    },
    promptInput: {
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      paddingHorizontal: spacing.lg,
      paddingVertical: 12,
      fontSize: fontSize.sm,
      color: colors.foreground,
      minHeight: 120,
      marginTop: 8,
    },
    promptRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 12,
      marginTop: 8,
    },
    promptRowText: {
      flex: 1,
    },
    resetBtn: {
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 10,
      paddingVertical: 5,
      marginTop: 6,
    },
    resetBtnText: {
      fontSize: fontSize.sm,
      color: colors.mutedForeground,
    },
  });
