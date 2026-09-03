package com.readany.app.dev

import android.util.Log
import android.view.View
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
 *
 * 三键复活修复(2026-09-04):BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE 下,窗口失焦时系统
 * 会自动重新显示系统栏(退后台/启动期),重新聚焦后不会自动再藏,而 JS 只在状态变化时
 * 调用一次 setEnabled → 冷启动直达阅读器、后台恢复都会出现三键残留。
 * 这里记住最近一次请求状态,并注册 reapplyOnFocus 钩子:MainActivity 每次
 * onWindowFocusChanged(true) 时自动重发,保证"进入阅读器 / 回前台"后三键保持沉浸。
 */
@ReactModule(name = ReaderSystemBarsModule.NAME)
class ReaderSystemBarsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName() = NAME

  init {
    // 注册焦点重发钩子(每次获得焦点时重发最近一次状态)
    Log.i(TAG, "module constructed")
    ReaderSystemBarsModule.reapplyOnFocus = {
      Log.i(TAG, "focusReapply -> lastEnabled=${ReaderSystemBarsModule.lastEnabled}")
      apply(ReaderSystemBarsModule.lastEnabled ?: true)
    }
  }

  @ReactMethod
  fun setEnabled(enabled: Boolean) {
    Log.i(TAG, "setEnabled($enabled)")
    ReaderSystemBarsModule.lastEnabled = enabled
    apply(enabled)
  }

  private fun apply(enabled: Boolean) {
    // 状态已记入 lastEnabled;activity 未就绪时先放弃,等焦点重发兜底
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
    private const val TAG = "ReaderSystemBars"

    /** 最近一次请求的显隐状态;null = 尚未设置过(默认显) */
    @Volatile
    var lastEnabled: Boolean? = null

    /** 窗口重新获得焦点时重发最近一次状态(由 MainActivity.onWindowFocusChanged 调用) */
    @Volatile
    var reapplyOnFocus: (() -> Unit)? = null

    /**
     * 延迟兜底重发(启动期修复):冷启动时 splash→AppTheme 切换 / edge-to-edge 初始化
     * 会在焦点事件之后重置窗口 insets,把系统栏重新放出来(之后不再有 focus 通知)。
     * onResume 后错峰重发两档(500ms/1500ms)把复活的系统栏按 lastEnabled 重新收起;
     * 已处于目标状态的调用是 no-op,不会产生多余动画。
     */
    @JvmStatic
    fun scheduleReapply(host: View, delayMs: Long) {
      host.postDelayed(
        {
          Log.i(TAG, "delayedReapply($delayMs ms) -> lastEnabled=$lastEnabled")
          reapplyOnFocus?.invoke()
        },
        delayMs,
      )
    }
  }
}
