package com.readany.app.dev

import android.content.Context
import android.util.Log
import android.view.View
import android.view.inputmethod.InputMethodManager
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
 * ReaderKeyboardInsets — 键盘可见高度精确读数(微信同款方案,2026-09-05)。
 *
 * 读数链:InputMethodManager.getInputMethodWindowVisibleHeight()(键盘窗口*实际*
 * 可见高度,含输入法工具条/任意形态;是生态里微信级贴合的读数,reflection 调用,
 * 带稳定值缓存,避开键盘收起/切换瞬间的跳变) → 失败时回退
 * WindowInsets: ime + (ime < 窗口高−nav ? nav : 0)(标准 ROM 已含 nav 则不重复补)。
 * 事件随 insets 动画逐帧重发(keyboardInsetsChanged { bottom(dp?), isVisible })。
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

  /** 读当前键盘可见高(反射主读 + insets 兜底)并上报 */
  private fun emit() {
    val view = attachedView ?: return
    val windowInsets = ViewCompat.getRootWindowInsets(view)
    if (windowInsets == null) return
    val imeVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime())
    val imeBottom = windowInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom
    val navBottom = windowInsets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
    val windowHeight = view.height // decorView 高度即窗口高

    val visibleHeight = getImeWindowVisibleHeight()
    val keyboardPx = if (imeVisible) visibleHeight else 0

    val map: WritableMap = Arguments.createMap()
    map.putInt("bottom", keyboardPx)
    // nav 条 insets(键盘盖住三键时系统回 0 → 书内自动不加;书外=实际三键高,读数补齐到视觉顶)
    map.putInt("navBottom", navBottom)
    map.putBoolean("isVisible", imeVisible)
    reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("keyboardInsetsChanged", map)
  }

  /** InputMethodManager.getInputMethodWindowVisibleHeight() 反射(API25+,生态可用) */
  private fun getImeWindowVisibleHeight(): Int {
    return try {
      val imm =
          reactApplicationContext.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
              ?: return 0
      val method = imm.javaClass.getMethod("getInputMethodWindowVisibleHeight")
      val h = method.invoke(imm) as? Number ?: 0
      h.toInt()
    } catch (e: Exception) {
      Log.w(TAG, "getInputMethodWindowVisibleHeight failed: ${e.message}")
      0
    }
  }

  override fun getName() = NAME

  companion object {
    const val NAME = "ReaderKeyboardInsets"
    private const val TAG = "ReaderKeyboardInsets"
    private var lastStableHeight = 0
  }
}
