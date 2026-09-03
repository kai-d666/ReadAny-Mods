package com.readany.app.dev

import android.view.Window
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

/**
 * ReaderSystemBars — 阅读器系统栏统一显隐(状态栏+导航三键一次调用、单个系统动画)。
 *
 * 缘起(2026-09-04):react-native-edge-to-edge 的 SystemBars 对状态栏/导航栏是两次独立
 * native 调用,各自触发一次 insets 动画 → 面板收起时"工具栏先消失、三键几十 ms 后才消失"
 * 的二段式卡顿。这里一次 hide/show(Type.systemBars()) 让系统把两栏放进同一个动画。
 * setEnabled(false)=沉浸(两栏全藏,边缘滑动临时出);true=恢复。
 */
@ReactModule(name = ReaderSystemBarsModule.NAME)
class ReaderSystemBarsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName() = NAME

  @ReactMethod
  fun setEnabled(enabled: Boolean) {
    val activity = reactApplicationContext.currentActivity ?: return
    activity.runOnUiThread {
      val window: Window = activity.window ?: return@runOnUiThread
      val controller = WindowInsetsControllerCompat(window, window.decorView)
      controller.systemBarsBehavior =
          WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      if (enabled) {
        controller.show(WindowInsetsCompat.Type.systemBars())
      } else {
        controller.hide(WindowInsetsCompat.Type.systemBars())
      }
    }
  }

  companion object {
    const val NAME = "ReaderSystemBars"
  }
}
