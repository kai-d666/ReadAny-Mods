package com.readany.app.dev

import android.app.Activity
import android.util.Log
import android.view.View
import android.view.Window
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

/**
 * ReaderSystemBars — 阅读器系统栏统一显隐(状态栏+导航三键一次调用)。
 *
 * 缘起(2026-09-04):react-native-edge-to-edge 的 SystemBars 对状态栏/导航栏是两次独立
 * native 调用,各自触发一次 insets 动画 → 面板收起时"工具栏先消失、三键几十 ms 后才消失"
 * 的二段式卡顿。这里一次 hide/show(Type.systemBars()) 让系统把两栏放进同一个动画。
 * setEnabled(false)=沉浸(两栏全藏,边缘滑动临时出);true=恢复。
 *
 * 三键复活修复(2026-09-04):BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE 下,窗口失焦时系统
 * 会自动重新显示系统栏(退后台/启动期),重新聚焦后不会自动再藏,而 JS 只在状态变化时
 * 调用一次 setEnabled → 冷启动直达阅读器、后台恢复都会出现三键残留。
 * 这里记住最近一次请求状态,并注册重发钩子(MainActivity.onWindowFocusChanged /
 * onResume 延迟兜底),保证"进入阅读器 / 回前台"后三键保持沉浸。
 *
 * 无动画瞬时隐藏(2026-09-04,用户要求"立刻关,不要动画"):API 30+ 隐藏不再用
 * controller.hide(系统播放 200-300ms 动画,回前台那下"闪一下"就是它的动画前奏),
 * 改用 controlWindowInsetsAnimation(+ onReady 立即 finish(false))直接完成到隐藏态;
 * 另挂 insets 监听:系统强制重显三键的"第一帧"就收走(systemBars inset 从 0 变非 0)。
 * 低版本(API < 30)回退系统动画 hide,行为同前。
 */
@ReactModule(name = ReaderSystemBarsModule.NAME)
class ReaderSystemBarsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName() = NAME

  init {
    // 注册重发钩子(每次获得焦点/延迟兜底时重发最近一次状态)
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
        hideInstant(window)
      }
    }
  }

  companion object {
    const val NAME = "ReaderSystemBars"
    private const val TAG = "ReaderSystemBars"

    /** 最近一次请求的显隐状态;null = 尚未设置过(默认显) */
    @Volatile
    var lastEnabled: Boolean? = null

    /** 窗口重新获得焦点/延迟兜底时重发最近一次状态(由 MainActivity 调用) */
    @Volatile
    var reapplyOnFocus: (() -> Unit)? = null

    /**
     * 延迟兜底重发(启动期修复):冷启动时 splash→AppTheme 切换 / edge-to-edge 初始化
     * 会在焦点事件之后重置窗口 insets,把系统栏重新放出来(之后不再有 focus 通知)。
     * onResume 后错峰重发三档(500/1500/3000ms)把复活的系统栏按 lastEnabled 重新收起;
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

    /** 已挂 insets 监听器的 decorView(主题切换可能导致 decorView 重建,重建则重挂) */
    @Volatile
    private var watchedDecor: View? = null

    /**
     * insets 变化即时收起(把"闪一下"压到最小):
     * 系统把三键/状态栏重新放出来时会分发新的 insets(导航栏 inset 从 0 变非 0)——这正是
     * 它"刚出来"的那一帧。此时若应用处于沉浸态(lastEnabled=false),立刻瞬时隐藏,
     * 用户几乎感知不到三键出现过。ViewCompat.set 内部会链式保留原 insets 处理(RN/键盘等)。
     */
    @JvmStatic
    fun attachDecorViewWatcher(decorView: View?) {
      if (decorView == null || decorView === watchedDecor) return
      watchedDecor = decorView
      ViewCompat.setOnApplyWindowInsetsListener(decorView) { view, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
        if (lastEnabled == false && (bars.bottom > 0 || bars.top > 0)) {
          Log.i(TAG, "insetsResurrection -> hide instant")
          val activity = view.context as? Activity
          if (activity != null) {
            val window = activity.window
            hideInstant(window)
          }
        }
        insets
      }
    }

    /**
     * 隐藏系统栏(系统动画)。
     *
     * 2026-09-04 曾尝试 controlWindowInsetsAnimation + finish(false) 做"瞬时无动画",
     * 实测本机(OriginOS)会与系统显示动画抢控制权 → 三键"闪两下",比动画版更糟。
     * 回退系统动画 hide:回前台三键"闪一下后消失"(已验收达标),关闭面板时系统
     * 会把三键滑入同一 insets 动画,体验已够好。
     */
    @JvmStatic
    fun hideInstant(window: Window?) {
      if (window == null) return
      val controller = WindowInsetsControllerCompat(window, window.decorView)
      controller.systemBarsBehavior =
          WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsetsCompat.Type.systemBars())
    }
  }
}
