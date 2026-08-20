/**
 * 扩展 RN TextInputProps,补充 Android 专有属性 includeFontPadding
 * (RN 公开类型未导出该 prop,但 AndroidTextInputNativeComponent 支持)
 */
import type { TextInputProps } from "react-native";

declare module "react-native" {
  interface TextInputProps {
    includeFontPadding?: boolean;
  }
}
