package com.readany.app.dev

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * ReaderKeyboardInsets — 键盘可见高度精确读数(2026-09-05 定稿)。
 *
 * 读数:WindowInsets.ime().bottom(键盘顶到窗口底完整距离)。
 * 实测(本机 vivo):ime insets = InputMethodManager 可见高(835px)+ 三键条(126px)= 961px,
 * 系统已代理三键条,输入栏底边按它顶起即贴键盘视觉顶;IMM 读数缺三键条(书外必留空隙、
 * 收起动画中先跳 0)。书内三键隐藏时 ime 自动=净键盘高,行为不变。
 * 事件随 insets 动画逐帧重发(keyboardInsetsChanged { bottom(px), isVisible })。
 */
@ReactModule(name = ReaderKeyboardInsetsModule.NAME)
class ReaderKeyboardInsetsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private var attachedView: View? = null

  @ReactMethod
  fun attach() {
    val activity = reactApplicationContext.currentActivity ?: return
    activity.runOnUiThread {
      val view = activity.window.decorView ?: return@runOnUiThread
      if (view === attachedView) return@runOnUiThread
      attachedView = view
      ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
        emit()
        insets
      }
      emit()
    }
  }

  /** 读当前键盘可见高(ime insets)并上报 */
  private fun emit() {
    val view = attachedView ?: return
    val windowInsets = ViewCompat.getRootWindowInsets(view)
    if (windowInsets == null) return
    val imeVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime())
    val imeBottom = windowInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom

    val keyboardPx = if (imeVisible) imeBottom else 0

    val map: WritableMap = Arguments.createMap()
    map.putInt("bottom", keyboardPx)
    map.putBoolean("isVisible", imeVisible)
    reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("keyboardInsetsChanged", map)
  }

  override fun getName() = NAME

  companion object {
    const val NAME = "ReaderKeyboardInsets"
  }
}
