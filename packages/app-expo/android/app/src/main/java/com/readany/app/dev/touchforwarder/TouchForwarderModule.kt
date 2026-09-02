package com.readany.app.dev.touchforwarder

import android.view.View
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.reader.ReaderTouchState

/**
 * 柱2:触摸转发控制器(JS→Native)。
 *
 * - setActive/setRect:书页激活与阅读区(屏幕物理像素)
 * - setTargetViewTag:常驻阅读 WebView 的 reactTag(经 UIManager 解析为原生 View)
 * 状态写入 RN 源码侧的 ReaderTouchState;ReactRootView 每帧触摸检查。
 */
class TouchForwarderModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "TouchForwarder"

    @ReactMethod
    fun setActive(active: Boolean) {
        dbg("setActive=$active")
        ReaderTouchState.active = active
        // 重新激活时清掉 target(避免 0x0 等错缓存;拦截时 ReactRootView 会重找)
        if (!active || ReaderTouchState.targetView == null) {
            ReaderTouchState.targetView = null
        }
    }

    @ReactMethod
    fun setRect(left: Float, top: Float, right: Float, bottom: Float) {
        dbg("setRect l=$left t=$top r=$right b=$bottom")
        ReaderTouchState.left = left
        ReaderTouchState.top = top
        ReaderTouchState.right = right
        ReaderTouchState.bottom = bottom
    }

    /** 诊断日志(app files/tfdebug.txt,run-as 读取;定位后删除) */
    private fun dbg(msg: String) {
        try {
            val f = java.io.File(reactApplicationContext.filesDir, "tfdebug.txt")
            f.appendText(
                java.text.SimpleDateFormat("HH:mm:ss.SSS").format(java.util.Date()) + " " + msg + "\n",
            )
        } catch (e: Exception) {
            // ignore
        }
    }

    @ReactMethod
    fun setTargetViewTag(tag: Int) {
        ReaderTouchState.targetView = resolveViewById(tag)
    }

    private fun resolveViewById(tag: Int): View? {
        val view = try {
            val fabricUIManager =
                com.facebook.react.uimanager.UIManagerHelper.getUIManager(
                    reactApplicationContext,
                    com.facebook.react.uimanager.UIManagerHelper.getSurfaceId(reactApplicationContext),
                )
            fabricUIManager?.resolveView(tag)
        } catch (e: Exception) {
            // Fabric 路径失败时退回 UIManagerModule(旧接口)
            try {
                reactApplicationContext
                    .getNativeModule(com.facebook.react.uimanager.UIManagerModule::class.java)
                    ?.resolveView(tag)
            } catch (e2: Exception) {
                null
            }
        }
        return view
    }
}
