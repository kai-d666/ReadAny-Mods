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

## 2026-08-21 进度更新(已配置,构建卡住)

**已完成**:
- `settings.gradle`:include ':ReactAndroid' + projectDir(源码参与构建)
- `app/build.gradle`:`implementation(project(":ReactAndroid"))` 替换 AAR
- **磁盘方案**:app/build 与 ReactAndroid/build 均 junction 到 `G:\lingshiiiiiii\`(D 盘只剩 13G;gradle 无感知,产物写 G 盘,已验证)
- 构建命令:`./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a`

**卡点(当前)**:
- `BUILD FAILED: No variants exist` — 根因:`node_modules/react-native/ReactAndroid/gradle/` 目录缺失(`libs.versions.toml` 不在),android.library 插件解析失败,ReactAndroid 无 variants
- **解法方向**:从 GitHub react-native v0.81.5 补回 `ReactAndroid/gradle/`(libs.versions.toml),或查 react-native npm 包 files 为何不含该目录(pnpm 裁剪?)
- 补回后预计还有后续坑(NDK/CMake 版本,参考 android-toolchain 记忆)

## 2026-08-22 实施完成(源码构建 + 拖动/编辑分离 patch 全部生效)

**源码构建最终方案(已验证 BUILD SUCCESSFUL)**:
- `settings.gradle`: `includeBuild('../../../node_modules/react-native') { dependencySubstitution { substitute(module("com.facebook.react:react-android")).using(project(":packages:react-native:ReactAndroid")) } }`(官方方式:includeBuild 复合构建,项目名≠artifactId 必须显式 substitution)
- `app/build.gradle`: 保持 `implementation("com.facebook.react:react-android")`(复合构建自动替换)
- 磁盘:app/build、ReactAndroid/build、hermes-engine/build 三个目录 junction 到 `G:\lingshiiiiiii\`(D 盘仅 13G,产物全写 G 盘)
- 构建命令:`./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a`(arm64-only,首次 6-12 分钟;debug 变体首次 ~12 分钟)
- Hermes:hermesc 用 npm 包自带预编译(`sdks/hermesc/win64-bin/`),patch hermes-engine/build.gradle.kts 空转 configureBuildForHermes/buildHermesC + `HERMES_ENABLE_TOOLS=False` + `HERMES_ENABLE_TEST_SUITE=False` + 手工 ImportHermesc.cmake 指向预编译 hermesc + 跳过 downloadHermes/unzipHermes(离线)
- 注意:pnpm install 后 node_modules 内所有 patch 会还原,需重新应用(建议 patch-package 固化)

**ReactEditText.kt 最终 patch(拖动/编辑分离 + 左对齐)**:
- DOWN: `showSoftInputOnFocus = false`(按下不弹键盘)+ `isCursorVisible = false`(隐藏光标)+ requestDisallowInterceptTouchEvent
- MOVE: 位移超 touchSlop → `dragged = true`
- UP 拖动: 吞掉(return true,不光标不编辑)+ `suppressBlurScroll = true`(失焦不滚回)+ `super.setSelection(可视区中间位置)`(光标虚拟位置移到可视区,防系统 ensureCursorVisible 弹回开头)
- UP 点击(未拖动): `isCursorVisible = true` + `showSoftInputOnFocus = true` + `inputMethodManager.showSoftInput(this, 0)`(正常编辑)
- onLayout 首次: `layoutSettled` 防重入,`isCursorVisible = false` + `super.setSelection(0, 0)` + `scrollTo(0, 0)`(挂载左对齐,setText 后 selection 默认末尾会右对齐)
- onFocusChanged 失焦: `suppressBlurScroll` 时不滚回,否则 `isCursorVisible = false` + `scrollTo(0, 0)`(编辑后失焦左对齐)
- setSelection override: `isCursorVisible == false` 时忽略(阻止 selection 驱动的 ensureCursorVisible 滚动)
