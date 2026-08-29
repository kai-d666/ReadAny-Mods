/**
 * WebView 聊天排版性能验证原型 — 内联 HTML 构建器。
 *
 * 目的:验证"聊天消息列表搬进 WebView(浏览器排版本)"能否解决
 * RN 原生文本布局导致的卡顿。与真实实现同策略:
 *   - 历史消息 = 已排版 HTML(Foliate/Chromium DOM)
 *   - 流式消息 = 纯文本 textContent 追加,完成后才排版
 * 页面内置 FPS 面板 + 模拟流式输出按钮,真机 30s 体感用。
 */
/** JS 单引号字符串不允许裸换行:多行文本注入 '<script>' 前需转义 */
function toJsStringLiteral(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r\n|\r|\n/g, "\\n");
}

export interface DemoHtmlColors {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  border: string;
  primary: string;
}

export function buildWebviewPerfDemoHtml(c: DemoHtmlColors): string {
  const streamText = DEMO_STREAM_TEXT;
  const bg = c.background;
  const fg = c.foreground;
  const card = c.card;
  const cardFg = c.cardForeground;
  const border = c.border;
  const primary = c.primary;

  // 预置长消息(HTML 化的历史消息,模拟 markdown 渲染结果)
  const presetMessages = `
    <div class="row user">
      <div class="bubble u">为什么阅读器里翻页很顺滑,但聊天界面文字一多就卡?帮我分析一下根因。</div>
    </div>
    <div class="row ai">
      <div class="bubble a">
        <p>这是个典型的<b>渲染管线分层</b>问题。你的阅读器是 WebView 里用浏览器引擎排版,文字渲染全部交给 Chromium;而聊天窗口是用 React Native 的原生组件体系(每个 Markdown 标签实例化成原生 View/Text 节点),文字一多,原生布局与测量成本线性上涨。</p>
        <h4>具体而言,卡顿来自三个层次:</h4>
        <ol>
          <li><b>布局与测量</b>:几百个 Text/View 节点逐层 measure/layout,RN 没有 CSS 排版引擎,每个节点都要单独测算;</li>
          <li><b>组件重建</b>:流式时每 160ms 发布一次增量,旧消息若能 memo 住还好,但富文本组件树每一次都可能重建;</li>
          <li><b>过度绘制</b>:每帧创建大树,驱动一次性渲染,刷新丢失。</li>
        </ol>
        <pre><code>// 伪代码:每 160ms 一次的全量解析
onToken(text) {
  ast = parseMarkdown(text)      // 长文本 => 数十 ms
  tree = buildComponentTree(ast) // 成千上万 RN 节点
  flush();                       // 原生布局,主线程爆破
}</code></pre>
        <blockquote>结论:不是 RN 框架慢,而是"大量富文本节点"这个负载形态在原生组件体系里天生昂贵。浏览器引擎的排版(TextFlow/Chrome Layout)处理同等负载要轻两个数量级。</blockquote>
        <table>
          <tr><th>渲染方式</th><th>5000 字 ~ 30ms 帧率</th><th>发热/内存</th></tr>
          <tr><td>RN 原生组件</td><td>卡顿明显,需节流+CAS 优化</td><td>较高</td></tr>
          <tr><td>WebView(Chromium)</td><td>长文依然流畅</td><td>更低(一次性布局)</td></tr>
        </table>
        <p>所以业界同量级产品(Koodo Reader 等)的 AI 聊天索性全走 WebView 渲染,换一种"引擎"而不是换"参数"。后面我放了一个模拟流式输出的按钮,你可以直观对比。<a href="#" data-cite="12">[12]</a><a href="#" data-cite="13">[13]</a></p>
      </div>
    </div>
    <div class="row user">
      <div class="bubble u">那迁移到 WebView 以后,长按/选词、引用跳转、代码复制这些交互怎么办?</div>
    </div>
    <div class="row ai">
      <div class="bubble a">
        <p>交互部分仍然归 RN 管,WebView 只负责"显示",两者通过桥接配合。对照我们的阅读器,它已经是这个模式了:</p>
        <ul>
          <li><b>引用跳转</b> —— HTML 里 <code>[N]</code> 渲染成链接,点击后 <code>postMessage</code> 回 RN,由 RN 执行既有跳转逻辑;</li>
          <li><b>长按/选词</b> —— 复用阅读器既有的选中句柄与文本选择桥接(ReaderScreen 已经做通了);</li>
          <li><b>代码复制/流式停止/重试</b> —— RN 的按钮照旧,HTML 只接收指令;</li>
          <li><b>主题</b> —— 主题色以 CSS 变量注入,深浅色切换即时生效。</li>
        </ul>
        <p>一句话:<b>换"心脏"(渲染引擎)不换"脸"(功能与界面)</b>。下面这条消息的流式演示会在完成后瞬间切换成排版样式,验证"流式纯文本 → 完成即排版"的体验过渡。</p>
      </div>
    </div>
    <div class="row ai">
      <div class="bubble a" id="streamBubble">
        <p>好的,现在我来帮你把"流式 + 超长文本"这个最苛刻的场景跑一遍:点击页面上方按钮,这里会以 Web 模拟的方式产出 8000 字,每 30ms 追加一批——模拟大模型逐字输出的速度。注意观察追加期间文字是否平滑地向下流动、FPS 是否保持稳定。</p>
        <div class="stream" id="streamText">(初始空白,点按钮开始)</div>
      </div>
    </div>`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<style>
  :root {
    --bg: ${bg};
    --fg: ${fg};
    --card: ${card};
    --card-fg: ${cardFg};
    --border: ${border};
    --primary: ${primary};
    --code-bg: rgba(127,127,127,0.14);
    --dim: color-mix(in srgb, var(--fg) 45%, var(--bg));
  }
  html, body { margin:0; padding:0; background: var(--bg); }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 15px; line-height: 1.7; color: var(--fg);
    -webkit-text-size-adjust: 100%;
  }
  #panel {
    position: fixed; top: 0; left: 0; right: 0; z-index: 10;
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px;
    background: var(--card); border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  #panel .btn {
    background: var(--primary); color: #fff; border: none; border-radius: 14px;
    padding: 8px 14px; font-size: 13px; font-weight: 600;
  }
  #panel .btn.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  #fps { color: var(--dim); white-space: nowrap; }
  #list { padding: 64px 12px 24px; }
  .row { display: flex; margin-bottom: 14px; }
  .row.user { justify-content: flex-end; }
  .bubble {
    max-width: 86%; border-radius: 16px; padding: 10px 14px;
    word-break: break-word; overflow: hidden;
  }
  .bubble.u { background: var(--primary); color: #ffffff; }
  .bubble.a { background: var(--card); color: var(--card-fg); border: 1px solid var(--border); }
  .bubble h3, .bubble h4 { margin: 10px 0 6px; font-weight: 700; }
  .bubble p { margin: 6px 0; }
  .bubble ul, .bubble ol { margin: 6px 0; padding-left: 20px; }
  .bubble li { margin: 3px 0; }
  .bubble pre {
    background: var(--code-bg); border-radius: 10px; padding: 10px 12px;
    overflow-x: auto; font-size: 12.5px; line-height: 1.5; margin: 8px 0;
  }
  .bubble pre code { font-family: "JetBrains Mono", Consolas, Menlo, monospace; color: var(--fg); }
  .bubble code { font-family: "JetBrains Mono", Consolas, Menlo, monospace; font-size: 13px; background: var(--code-bg); padding: 1px 5px; border-radius: 5px; }
  .bubble blockquote {
    margin: 8px 0; padding: 2px 12px; border-left: 3px solid var(--primary);
    color: var(--dim); background: rgba(127,127,127,0.07); border-radius: 0 8px 8px 0;
  }
  .bubble table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 13px; }
  .bubble th, .bubble td { border: 1px solid var(--border); padding: 5px 8px; text-align: left; }
  .bubble th { background: rgba(127,127,127,0.08); font-weight: 600; }
  .bubble a { color: var(--primary); text-decoration: none; margin: 0 1px; }
  .stream { white-space: pre-wrap; color: var(--card-fg); }
  #toBottom {
    position: fixed; bottom: 14px; right: 14px; z-index: 10; display: none;
    background: var(--primary); color: #fff; border-radius: 16px; padding: 8px 14px; font-size: 13px;
  }
</style>
</head>
<body>
  <div id="panel">
    <button class="btn" id="btnStream">▶ 模拟流式 8000 字</button>
    <button class="btn secondary" id="btnMore">⊕ 再插 8 条</button>
    <span id="fps">--</span>
  </div>
  <div id="list">${presetMessages}</div>
  <button id="toBottom">↓ 回到底部</button>
<script>
(function () {
  var streamText = '${toJsStringLiteral(streamText)}';
  var APPEND_INTERVAL = 30;
  var APPEND_CHUNK = 80;

  // ── FPS 面板:rAF 采样,统计平均帧率/掉帧(>50ms)/最差帧 ──
  var frames = 0, worst = 0, dropped = 0, last = null, acc = 0;
  var fpsEl = document.getElementById('fps');
  function tick(now) {
    if (last !== null) {
      var d = now - last;
      acc += d; frames++;
      if (d > 50) { dropped++; }
      if (d > worst) { worst = d; }
      if (acc >= 500) {
        fpsEl.textContent = 'FPS ' + Math.round(frames * 1000 / acc) + ' · 掉帧' + dropped + ' · 最差' + Math.round(worst) + 'ms';
        frames = 0; acc = 0; dropped = 0; worst = 0;
      }
    }
    last = now;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  var streamTextEl = document.getElementById('streamText');
  var listEl = document.getElementById('list');
  var toBottom = document.getElementById('toBottom');
  var scrollEl = document.scrollingElement || document.documentElement;
  var stick = true; // 用户滚离底部则暂停自动滚动

  function nearBottom() {
    return scrollEl.scrollHeight - scrollEl.scrollTop - window.innerHeight < 80;
  }

  window.addEventListener('scroll', function () {
    var isNear = nearBottom();
    if (isNear !== stick) {
      stick = isNear;
      toBottom.style.display = isNear ? 'none' : 'block';
    }
  }, { passive: true });

  toBottom.addEventListener('click', function () {
    window.scrollTo(0, scrollEl.scrollHeight);
    stick = true; toBottom.style.display = 'none';
  });

  function post(msg) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  }

  // 引用 [N] 链接 → 桥接回 RN
  document.addEventListener('click', function (e) {
    var t = e.target.closest('a');
    if (t && t.hasAttribute('data-cite')) {
      e.preventDefault();
      post({ type: 'cite', index: t.getAttribute('data-cite') });
    }
  }, true);

  var running = false;
  document.getElementById('btnStream').addEventListener('click', function () {
    if (running) return;
    running = true;
    var pos = 0;
    streamTextEl.textContent = '';
    var timer = setInterval(function () {
      if (pos >= streamText.length) {
        clearInterval(timer);
        running = false;
        post({ type: 'streamDone' });
        return;
      }
      var end = Math.min(pos + APPEND_CHUNK, streamText.length);
      streamTextEl.textContent = streamText.substring(0, end);
      pos = end;
      if (stick) { listEl.scrollTop = listEl.scrollHeight; }
    }, APPEND_INTERVAL);
  });

  // "再插 8 条":把预置富文本消息重复插入,验证"超长会话 DOM 增长"下的滚动
  document.getElementById('btnMore').addEventListener('click', function () {
    var extra = '${toJsStringLiteral(presetMessages)}';
    var frag = document.createDocumentFragment();
    var tmp = document.createElement('div');
    tmp.innerHTML = extra;
    for (var i = 0; i < tmp.children.length; i++) {
      frag.appendChild(tmp.children[i].cloneNode(true));
    }
    listEl.appendChild(frag);
    post({ type: 'more', messages: document.querySelectorAll('.bubble').length });
  });

  post({ type: 'ready', messages: document.querySelectorAll('.bubble').length });
})();
</script>
</body>
</html>`;
  return html;
}

// 8000 字中文范文:为安全放入单引号模板,使用字符串拼接。
// 正文为 5 段循环拼接(约 8400 字)+ 分隔线,保证流式压力与文案一致。
const BASE_STREAM_TEXT = [
  "先说结论,这取决于你如何定义\"卡\":",
  "一、先明确:卡在谁的线程上?",
  "1. JS 线程(业务逻辑):我们已做过采样,聊天流式期间 JS 线程约九成空闲。onToken 事件 160ms 发布一次,合并、转换、节流都做了前置,逻辑上不算重。",
  "2. UI 线程(原生布局):这就是关键。RN 渲染富文本时,会把一段 Markdown 解析后瞬间实例化为成千上万个原生 View/Text 节点。长回复=每一轮增量都触发全树布局,原生 measure/layout 是线性膨胀的;节点树越大,越接近一帧 16.6ms 的预算红线。",
  "3. 渲染管线:Android 硬件加速模块对大量 Text 层的合成也很费,动辄 600ms 一帧的卡顿就出现在这种场景。",
  "",
  "二、为什么阅读器不卡而聊天卡?",
  "阅读器是 WebView + foliate-js,文字排版交给 Chromium。浏览器引擎的排版是一个 C++ 级别的 Text 布局系统,且对文本增量更新做了优化(kLayoutInline 树、纹理缓存、图层合成)。同样 5000 字,它所消耗的成本远低于原生逐节点测量。聊天界面之所以卡,是因为它不是 WebView。",
  "",
  "三、那怎么根治?",
  "把聊天消息区整体搬进 WebView。对比一下几个细节:",
  "第一,流式文本:HTML 里一个 <div> 的 textContent 追加,浏览器内部用 O(1) 字符串拼接 + 增量重排,而原生文本更新需要重建节点,再经历布局传递、样式传播、绘制合成。复杂度不在一个量级。",
  "第二,指令交互:引用 [N] 在 HTML 里就是 <a> 链接,click 时 postMessage 回 RN,既有逻辑零改动。长按选词、代码复制同样可以在 HTML 层实现,和阅读器选词桥接同构。",
  "第三,主题:CSS 变量注入。ThemeColors 转成 :root 变量,深浅色切换即为一次 className 翻转,天然支持系统主题跟随。",
  "",
  "四、改造的范围和风险。",
  "迁移范围:聊天消息列表区(气泡/引用卡/工具卡/思考链)。输入栏、顶栏、侧栏、导航保持 RN 不变。难点在交互回归——尤其是流式状态下点击复制、关流、引用飘屏,这些仍然要桥回来。一旦做过一遍,风险是可控的。",
  "",
  "五、为什么我们不去做方案 B(RN 继续优化)?",
  "当前已经把 RN 侧所有明确的热点消灭:Markdown 解析迁到原生 md4c、列表 memo 修复、切会话挂载从 1.1s 降到 127ms。但 600ms 的帧仍然存在,它就在原生布局层——用 RN 无论如何都绕不开这堵墙体。优化参数是治标,换引擎才是治本。",
  "六、收益预估。",
  "日常使用:长回复滚动跟手,不再出现 1 秒的卡顿。切换会话:富文本批量挂载变为 DOM 批量插入。内存:降低一截,因为不再维持几十层原生节点。风险:WebView 白屏恢复、字体加载时序、深色模式闪烁,这些老问题我们已有手段。",
  "七、最后给个大致粒度的时间线。",
  "一天左右做完消息气泡的 1:1 复刻与流式管线,两天完成交互闭环,两天打磨边界情境。总计是三到五个工作日,前端团队按这个节奏排就可以。",
  "",
  "八、回答你最初的问题。",
  "是的,阅读器不卡是因为它是 WebView。聊天卡是因为它不是。我们不是要把它变成阅读器,而是要借它的引擎——这正是 Koodo 等竞品已经验证过的路径:全浏览器渲染聊天内容,原生层只做输入与系统壳。工具链、桥接、排版,全部现成(阅读器已经趟平),我们只需要把这套搬过来。",
  "九、总结。",
  "1) JS 侧已无热点,瓶颈在原生文本布局;2) 布局墙无法靠调参数绕过;3) 迁移到 WebView 是结构性解法;4) 阅读器已证明这套架构可行;5) 排期约三到五日。",
].join("\n");

/** 循环拼接出约 8400 字(5 遍 × 1582 字 + 分隔),保证流式压力与按钮文案一致 */
export const DEMO_STREAM_TEXT = Array.from(
  { length: 5 },
  (_, i) => `━━━━ 第 ${i + 1} 节(重复段落,仅用于压力测试)━━━━\n${BASE_STREAM_TEXT}`,
).join("\n\n");
