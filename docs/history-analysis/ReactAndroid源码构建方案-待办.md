# 待办:ReactAndroid 源码构建方案(输入框拖动/编辑分离)

> 2026-08-21 记录。用户决定暂缓实施,先保留方案。

## 背景

用户想要:小输入框里长文本左右拖动查看,松手后**不**触发光标插入/输入法弹出(拖动 ≠ 编辑)。

## 根因链(已确认)

1. **文本被上下裁剪/拖动上下滚** → 已修复(JS 层):`paddingVertical: 0` + `includeFontPadding={false}`(提交 4815459)
2. **左右拖动查看文本是正常逻辑**(用户认可),但松手后 Android 原生 EditText 会定位光标 + 弹键盘 → **待解决**

## 关键发现:原生改动从未生效

- `app/build.gradle` 用 `implementation("com.facebook.react:react-android")` = **Maven 预编译 AAR**(0.81.5,缓存于 `D:/gradle/caches/modules-2/files-2.1/com.facebook.react/react-android/0.81.5/`)
- 改 `node_modules/react-native/ReactAndroid/...` 源码**不参与构建**——之前所有"原生 patch"构建都是 23s~2min 的 JS 增量,原生改动全部白改
- **要让原生生效必须让 ReactAndroid 源码参与构建**

## 实施方案(待做)

### 1. 源码构建配置
- `settings.gradle`:include ReactAndroid 源码工程(在 node_modules/react-native/ReactAndroid)
- `app/build.gradle`:依赖从 AAR 换成 `project(':ReactAndroid')`(或对应方式)
- 需要 RN 0.81 源码构建的第三方依赖解析 + autolinking 配合,有已知坑需现场调

### 2. 关键优化:只编 arm64-v8a
- 机器:16GB 内存 / 6核12线程 / D: 盘剩 18GB(92% 已用)
- 全量 4 ABI 首次 60-90 分钟、中间产物 6-10GB、内存可能爆 → **必须临时把 `reactNativeArchitectures` 改为 `arm64-v8a`**(手机 vivo V2118A 只需 arm64)
- arm64-only:首次约 20-40 分钟、中间产物 2-3GB
- 构建完改回 `armeabi-v7a,arm64-v8a,x86,x86_64`

### 3. 原生 patch 内容(已验证思路,待源码构建后实施)

`node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/views/textinput/ReactEditText.kt`:

```kotlin
// 字段(init 块前):
private var downRawX = 0f
private var downRawY = 0f
private var dragged = false
private val touchSlop: Int = ViewConfiguration.get(context).scaledTouchSlop
// import: android.view.ViewConfiguration

// onTouchEvent 改造:
override fun onTouchEvent(ev: MotionEvent): Boolean {
  when (ev.action) {
    MotionEvent.ACTION_DOWN -> {
      detectScrollMovement = true
      downRawX = ev.rawX
      downRawY = ev.rawY
      dragged = false
      this.parent.requestDisallowInterceptTouchEvent(true)
    }
    MotionEvent.ACTION_MOVE -> {
      if (detectScrollMovement) {
        if (!canScrollVertically(-1) && !canScrollVertically(1) &&
            !canScrollHorizontally(-1) && !canScrollHorizontally(1)) {
          this.parent.requestDisallowInterceptTouchEvent(false)
        }
        detectScrollMovement = false
      }
      if (!dragged && (Math.abs(ev.rawX - downRawX) > touchSlop ||
          Math.abs(ev.rawY - downRawY) > touchSlop)) {
        dragged = true
      }
    }
    MotionEvent.ACTION_UP ->
        // 拖动后松手:吞掉 UP,不触发光标插入/键盘弹出(拖动查看 ≠ 点击编辑)
        if (dragged) {
          dragged = false
          return true
        }
  }
  return super.onTouchEvent(ev)
}
```

### 4. patch 固化
- 用 patch-package 固化 node_modules 修改(`pnpm install` 后自动重应用),避免"改了不生效/被还原"
- 或复制 ReactEditText.kt 到项目内维护,构建前拷回

## 影响面确认

- 长按查词(WebView 内)不受影响——触摸不经过 TextInput
- 点击(无位移)不受影响——UP 正常,光标定位照旧
- 长按 TextInput 选文本不受影响(无位移)
