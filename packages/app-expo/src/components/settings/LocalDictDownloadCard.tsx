/**
 * LocalDictDownloadCard — 本地词典(ECDICT/stardict)下载卡:
 * 版本选择(精选/全量)+ 下载进度 + 已就绪信息(版本/大小)+ 删除。
 * 下载逻辑见 lib/dict/dictionary-download.ts(GitHub Release 直链,断点续传)。
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { fontSize, fontWeight, radius, useColors } from "@/styles/theme";
import {
  DICT_VARIANTS,
  deleteLocalDict,
  downloadLocalDict,
  getLocalDictInfo,
} from "@/lib/dict/dictionary-download";

export function LocalDictDownloadCard() {
  const { t } = useTranslation();
  const colors = useColors();
  const [readyInfo, setReadyInfo] = useState<Awaited<ReturnType<typeof getLocalDictInfo>>>(null);
  /** 下载中的版本 id;null = 未在下载 */
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [fraction, setFraction] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setReadyInfo(await getLocalDictInfo());
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const startDownload = useCallback(
    async (variantId: string) => {
      setError(null);
      setFraction(0);
      setDownloadingId(variantId);
      try {
        await downloadLocalDict(variantId as never, (p) => setFraction(p.fraction));
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setDownloadingId(null);
      }
    },
    [refresh],
  );

  const remove = useCallback(async () => {
    setError(null);
    try {
      await deleteLocalDict();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await refresh();
  }, [refresh]);

  const downloading = downloadingId != null;

  return (
    <View style={{ gap: 8 }}>
      {readyInfo ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Text style={{ fontSize: fontSize.sm, color: colors.foreground, flex: 1 }}>
            {t("settings.dictReady", "已就绪:{{label}}", {
              label: readyInfo.version.label,
            })}
            <Text style={{ color: colors.mutedForeground }}>
              {` (${(readyInfo.sizeBytes / 1024 / 1024).toFixed(1)}MB)`}
            </Text>
          </Text>
          <Pressable
            onPress={remove}
            disabled={downloading}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: radius.md,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.border,
              backgroundColor: colors.card,
            }}
          >
            <Text style={{ fontSize: fontSize.sm, color: colors.mutedForeground }}>
              {t("settings.dictDelete", "删除")}
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: fontSize.sm, color: colors.mutedForeground }}>
            {t("settings.dictNotDownloaded", "未下载离线词典")}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {DICT_VARIANTS.map((v) => (
              <Pressable
                key={v.id}
                onPress={() => startDownload(v.id)}
                disabled={downloading}
                style={{
                  flex: 1,
                  alignItems: "center",
                  paddingVertical: 8,
                  borderRadius: radius.md,
                  backgroundColor: colors.primary,
                  opacity: downloading ? 0.5 : 1,
                }}
              >
                <Text
                  style={{ fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: colors.primaryForeground }}
                >
                  {t("settings.dictDownloadVariant", "下载 {{label}}", {
                    label: v.label,
                  })}
                </Text>
                <Text style={{ fontSize: 10, color: colors.primaryForeground, opacity: 0.8 }}>
                  {v.entries}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {downloading && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={{ fontSize: fontSize.xs, color: colors.mutedForeground }}>
            {t("settings.dictDownloading", "下载中… {{percent}}%", {
              percent: Math.round(fraction * 100),
            })}
          </Text>
        </View>
      )}

      {error && (
        <Text style={{ fontSize: fontSize.xs, color: "#dc2626" }}>
          {t("settings.dictDownloadError", "下载失败:{{msg}}", { msg: error })}
        </Text>
      )}
    </View>
  );
}
