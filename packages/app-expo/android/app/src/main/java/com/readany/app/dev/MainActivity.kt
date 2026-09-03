package com.readany.app.dev
import expo.modules.splashscreen.SplashScreenManager

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {

  // volume-key-paging:dispatchKeyEvent
  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
    val keyCode = event.keyCode
    val isVolume = keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP ||
      keyCode == android.view.KeyEvent.KEYCODE_VOLUME_DOWN
    if (expo.modules.volumekeypaging.VolumeKeyPagingState.enabled &&
        expo.modules.volumekeypaging.VolumeKeyPagingState.emitter != null &&
        isVolume && hasWindowFocus() && !isInMultiWindowMode) {
      if (event.action == android.view.KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
        val direction =
          if (keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP) "prev" else "next"
        expo.modules.volumekeypaging.VolumeKeyPagingState.emitter?.invoke(direction)
      }
      return true
    }
    return super.dispatchKeyEvent(event)
  }

  /**
   * 系统栏焦点重发(2026-09-04,修三键显示 bug):
   * 沉浸模式下(BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE)窗口失焦时系统会把三键/状态栏
   * 重新显示,重新聚焦后不会自动再藏。冷启动 focus 迟到、退后台回前台都会触发。
   * 每次获得焦点时重发 ReaderSystemBars 最近一次请求的显隐状态(见 ReaderSystemBarsModule)。
   */
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) {
      ReaderSystemBarsModule.reapplyOnFocus?.invoke()
    }
  }

  /**
   * 启动期/回前台延迟兜底:冷启动时 splash→AppTheme 切换、edge-to-edge 初始化会在
   * 焦点事件之后重置窗口 insets,把系统栏重新放出来且不再有 focus 通知。
   * onResume 后错峰重发两档(已处于目标状态时是 no-op),把复活的系统栏按 lastEnabled 收起。
   */
  override fun onResume() {
    super.onResume()
    ReaderSystemBarsModule.scheduleReapply(window.decorView, 500)
    ReaderSystemBarsModule.scheduleReapply(window.decorView, 1500)
    ReaderSystemBarsModule.scheduleReapply(window.decorView, 3000)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    // setTheme(R.style.AppTheme);
    // @generated begin expo-splashscreen - expo prebuild (DO NOT MODIFY) sync-f3ff59a738c56c9a6119210cb55f0b613eb8b6af
    SplashScreenManager.registerOnActivity(this)
    // @generated end expo-splashscreen
    super.onCreate(null)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}
