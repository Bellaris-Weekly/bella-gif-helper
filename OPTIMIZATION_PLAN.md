# 贝报 GIF 助手 · 优化实施方案

> 面向执行 Agent的实施说明。基线：`bella-gif-helper.user.js` @version 1.4.15，

## 0. 全局约束（每个任务都适用）

**必须遵守**

1. **一个任务 = 一个提交**。不要把多个任务合并成一次提交。
2. 每次改动 `bella-gif-helper.user.js` 后，按 `AGENTS.md` 递增 `@version`，并在同一提交内包含版本号变更。只改 CI / 文档时不递增。
3. 每次提交前必须通过：
   ```bash
   node --check bella-gif-helper.user.js
   node --test tests/*.test.js     # 当前 47 个用例，必须全绿
   ```
4. **本文件中的行号仅为定位提示（基于 1.4.14）。改动请按函数名 / 常量名定位，不要按行号硬改。**
5. 不改动的红线：
   - 不动 GIF 调色 / 编码 / 解码的算法逻辑（`createGifEncodingSession`、`makeEncodingWorkerSource`、`createExportFrameSourceFromMediaApi`、`LiveRewindTrack` 及 fMP4 解析函数）
   - 不升级、不替换 `@resource` 里的四个依赖版本
   - 不对产物做混淆或压缩
   - 不改变用户可见行为，除非任务里明确写了

**手动冒烟清单**（结构性任务 T5–T7 每次完成后必须人工跑一遍，自动化测试覆盖不到这些路径）

- [ ] 视频页（`www.bilibili.com/video/*`）：框选 → 录制 → 编辑 → 导出 GIF
- [ ] 直播页回溯模式：点击悬浮球 → 拿到此前 60 秒 → 导出
- [ ] 直播页切换到录制模式 → 录制 → 导出
- [ ] 活动页 iframe 直播（`live.bilibili.com/blanc/*`）能正常框选与录制
- [ ] 文字图层：新增 / 拖动 / 删除 / 切换标签
- [ ] 时间轴：拖动起止点、缩略图刷新、拖完聚焦
- [ ] 面板拖拽与四边缩放，刷新后位置尺寸保持
- [ ] 快捷键 `Ctrl+Z` 启动；焦点在评论框时不劫持
- [ ] 1:1 开关关闭后刷新页面仍为关闭

---

## T0 · 建立测试关卡（最高优先级，先做）

**问题**：`.github/workflows/sync-r2.yml` 在 push 到 main 时直接把脚本同步到 R2，
即 `share.bellaris.fans` 的正式分发地址。中间没有任何测试关卡，改坏了会直接推给所有用户。

**改动**

1. 新建 `package.json`（**不要**设 `"type": "module"`，测试用的是 CommonJS `require`）：
   ```json
   {
     "name": "bella-gif-helper",
     "version": "0.0.0",
     "private": true,
     "description": "B站直播回溯、视频框选录制与 GIF 编辑用户脚本",
     "license": "MIT",
     "scripts": {
       "check": "node --check bella-gif-helper.user.js",
       "test": "node --test tests/*.test.js",
       "verify": "npm run check && npm test"
     },
     "engines": { "node": ">=22" }
   }
   ```
2. 改造 `.github/workflows/sync-r2.yml`：在现有 `upload` job 前加一个 `test` job，
   并给 `upload` 加 `needs: test`。
   - `test` job：`actions/checkout@v4` → `actions/setup-node@v4`（node-version: 22）→ `npm run verify`
   - `test` 的触发条件放宽到 `push`（全分支）+ `pull_request`；`upload` 保持只在 `main` 且路径匹配时跑
3. `.gitignore` 追加 `node_modules/`

**验收**：本地故意在脚本里写一个语法错误，`npm run verify` 必须失败；恢复后必须通过。

**提交**：`ci: gate R2 sync behind syntax and test checks`（不递增 @version）

---

## T1 · 提交 1:1 记忆改动并同步文档

**背景**：工作区已有一处未提交改动——1:1 裁剪开关的状态持久化。

**改动**

1. `@version` 递增到 `1.4.15`
2. `README.md`：
   - 「当前版本为 `1.4.13`」→ `1.4.15`
   - 功能列表补一条：记住 1:1 裁剪开关状态
   - **修正失实描述**：现在写的是「文件大小通过选区内连续画面的真实编码与压缩结果估算」，
     但 `updateEstimatedFileSize()` 实际是基于 `colorComplexity` / `motionComplexity` 的经验公式，
     误差 30%~50%（代码里的 tooltip 是对的）。改成与实现一致的表述。

**提交**：`feat: remember 1:1 crop lock across sessions`

---

## T2 · 统一偏好存储（含存量迁移）

**问题**：现在有 6 个偏好键，分属两套机制。`www.bilibili.com` / `live.bilibili.com` /
`m.bilibili.com` 是三个不同 origin，`localStorage` 互不相通，导致导出档位、悬浮球位置、
1:1 开关在站点间不一致。

| 常量 | 当前机制 | 跨站点 |
|---|---|---|
| `SHORTCUT_KEY` | `GM_setValue` | ✅ |
| `PANEL_GEOMETRY_KEY` | `GM_setValue` | ✅ |
| `LAUNCHER_POSITION_KEY` | `localStorage` | ❌ |
| `EXPORT_PREFERENCES_KEY` | `localStorage` | ❌ |
| `LIVE_CAPTURE_MODE_KEY` | `localStorage` | ❌ |
| `ASPECT_SQUARE_KEY` | `localStorage` | ❌ |

**改动**

1. 在 IIFE 顶层（**必须在 `startApp` 之外**，因为 `LIVE_CAPTURE_MODE_KEY` 在
   L2081 附近于 `document-start` 阶段、且在子 iframe 中就要读）新增：

   ```js
   const PREFS_KEY = 'biliGifMakerPrefsV1';
   const LEGACY_PREF_KEYS = {
     launcherPosition: 'biliGifMakerLauncherPositionV1',
     exportPreferences: 'biliGifMakerExportPreferencesV1',
     liveCaptureMode:  'biliGifMakerLiveCaptureModeV1',
     aspectSquare:     'biliGifMakerAspectSquareV1',
   };
   ```

   实现三个函数：
   - `readPrefs()` —— `GM_getValue(PREFS_KEY, null)`，失败或非对象时返回 `{}`；结果做进程内缓存
   - `writePrefs(patch)` —— 浅合并后 `GM_setValue`，同时更新缓存
   - `migrateLegacyPrefs()` —— 只在 `readPrefs()` 里**尚不存在**对应字段时，
     从旧 `localStorage` 键读一次并写入统一存储；迁移后**不要**删除旧键
     （用户可能在多台设备 / 多个脚本管理器间回退）

2. `SHORTCUT_KEY` 和 `PANEL_GEOMETRY_KEY` 也并入 `PREFS_KEY` 对象（字段名 `shortcut`、`panelGeometry`），
   迁移方式同上：旧值从 `GM_getValue(SHORTCUT_KEY)` / `GM_getValue(PANEL_GEOMETRY_KEY)` 读。

3. 逐个替换调用点（按符号定位）：
   - `applyLauncherPosition()` 的 `localStorage.setItem(LAUNCHER_POSITION_KEY, …)`
   - `restoreLauncherPosition()`
   - `restoreExportPreferences()` / `saveExportPreference()`
   - `readAspectSquarePreference()` / `saveAspectSquarePreference()`
   - `setLiveCaptureMode()` 与 L2081 附近的 `initialLiveCaptureMode` 初始化
   - `restoreShortcutPreference()` / `saveShortcutPreference()`
   - `readSavedPanelGeometry()` / `savePanelGeometry()`

4. 删除 6 个旧常量声明，只保留 `LEGACY_PREF_KEYS` 里的字符串。

**行为变化（需在 README 说明）**：悬浮球位置、导出档位、1:1 开关现在跨 B 站各子站共享。

**验收**
- 老用户（`localStorage` 里已有值）升级后设置不丢失
- 在视频页关闭 1:1 → 打开直播页 → 仍为关闭
- `GM_setValue` 不可用时（降级环境）不抛错，走默认值
- 47 个测试全绿；`tests/shortcut.test.js` 涉及 `DEFAULT_SHORTCUT`，注意别改动其导出

**提交**：`refactor: unify preferences into a single cross-origin store`（@version → 1.4.16）

---

## T3 · 可诊断的错误日志

**问题**：全脚本 59 处 `catch (_) { }`，0 处 `console.*`。线上出问题没有任何排查线索。
分布：L1000-1999:12，L2000-2999:6，L3000-3999:7，L4000-4999:14，L5000-5999:13，L6000-6999:6，L7000+:1。

**改动**

1. 顶层新增（同样在 `startApp` 之外，子 frame 也要能用）：
   ```js
   const DEBUG = (() => {
     try { return GM_getValue('biliGifMakerDebugV1', false) === true; } catch (_) { return false; }
   })();
   function debugLog(scope, error) {
     if (!DEBUG) return;
     try { console.warn(`[bella-gif][${scope}]`, error); } catch (_) { }
   }
   ```
2. 把 59 处 `catch (_) { }` 全部改成 `catch (error) { debugLog('<scope>', error); }`。
   `<scope>` 用所在函数名，例如 `catch (error) { debugLog('savePanelGeometry', error); }`。
3. **默认关闭**，用户不受影响；开启方式写进 README「反馈」小节：
   在脚本管理器控制台执行 `GM_setValue('biliGifMakerDebugV1', true)` 后刷新。

**注意**：只改 `catch (_) { }` 这种**完全空**的块。已有处理逻辑的 catch 不动。

**验收**：`DEBUG=false` 时控制台零输出；开启后能看到日志；47 个测试全绿。

**提交**：`feat: add opt-in debug logging for silenced failures`（@version → 1.4.17）

---

## T4 · 指针事件用 rAF 合并

**问题**：所有 `pointermove` handler 每个事件同步跑几何计算并写样式。
`positionAspectSquareButton()` 每次读 `offsetWidth` / `offsetHeight`，触发强制同步布局。
120Hz 指针设备上拖裁剪框 / 时间轴会掉帧。

**改动**

1. 新增通用工具：
   ```js
   function createFrameScheduler(handler) {
     let pending = null;
     let rafId = 0;
     return {
       schedule(event) {
         pending = event;
         if (rafId) return;
         rafId = requestAnimationFrame(() => {
           rafId = 0;
           const next = pending;
           pending = null;
           if (next) handler(next);
         });
       },
       cancel() {
         if (rafId) cancelAnimationFrame(rafId);
         rafId = 0;
         pending = null;
       },
     };
   }
   ```
2. 应用到这些 handler（保留原函数体作为 `handler`，对外暴露的 listener 只做 `event.preventDefault()` + `schedule()`）：
   - `handleEditorCropPointerMove`
   - `handleTimelinePointerMove`
   - `handlePageSelectPointerMove`
   - `handlePageMarkerPointerMove`
   - `handlePanelHeaderPointerMove`
   - `handlePanelResizePointerMove`
   - `handleTextLayerPointerMove`
   - `handleLauncherPointerMove`
3. 对应的 `finish*` / `pointercancel` 分支里调用 `cancel()`，
   并且**必须在 cancel 之前把最后一帧同步应用一次**，否则松手位置会比手指落后一帧。
4. `positionAspectSquareButton()`：把 `offsetWidth` / `offsetHeight` 的读取结果缓存在
   `state` 上，只在按钮内容或面板尺寸变化时重新测量。

**验收**：拖动裁剪框、时间轴、面板边缘均无视觉延迟；松手后位置与手指一致（这一条容易回归，务必手测）。

**提交**：`perf: coalesce pointer-driven layout writes into animation frames`（@version → 1.4.18）

---

## T5 · 清理重复与死引用

**改动**

1. **录制启动去重**：`startRemoteRecording()` 与 `startRecording()` 各写了一遍状态迁移、
   `setInterval(() => updateRecordingUi(recording), 200)`、`el.panel.classList.add('hidden')`、
   `updateModeUi()`、`setStatus('')`，以及 catch 里的回滚。抽出：
   ```js
   function beginRecordingSession(recording, { maxTimer = false } = {})
   function abortRecordingSession(error)
   ```
   顺带修掉两条路径对 `maxTimerId` 处理不一致的问题（远程路径用 `setTimeout`，
   本地路径依赖 `createCanvasRecording` 内部计时）——统一由 `beginRecordingSession` 负责，
   并确认 `cleanupRecordingResources()` 两种情况都清得干净。
2. 删除未使用的 DOM 引用 `editorOverlay: $('#editorOverlay')`（`el` 表里没有任何
   `el.editorOverlay` 使用点）。**保留** CSS 规则 `#editorOverlay` 和 HTML 里的
   `<div id="editorOverlay">`，它们是有效的。
3. `waitForEvent()` 里 `done` / `fail` 两个闭包的 settled 守卫是重复块，合并成一个
   `settle(fn)` 辅助。

**验收**：本地录制和活动页 iframe 远程录制都能正常起停；到达 60 秒上限时两条路径都会自动停止并提示。

**提交**：`refactor: unify recording session bootstrap`（@version → 1.4.19）

---

## T6 · 引入构建，产物仍是单文件

> 从这里开始是结构性改造。**每一步 diff 必须是纯移动，逻辑改动一律另开提交。**

**问题**：`startApp` 一个函数 5405 行（L2156–L7560），装了全脚本约 85% 的业务代码。
`tests/load-userscript-api.js` 只能用 `vm` + 字符串标记
`"\n  const IS_LIVE_PAGE = location.hostname === 'live.bilibili.com';"`
把文件从中间劈开，导致 `startApp` 里 5400 行**零测试覆盖**。

**改动**

1. `npm i -D esbuild`
2. 目录：
   ```
   src/
     header.txt      # ==UserScript== 头 + 三方许可证注释（原样搬运，不改内容）
     main.js         # 现有 IIFE 的函数体（去掉最外层 (() => { 'use strict'; ... })()）
   build.mjs
   ```
3. `build.mjs`：
   ```js
   import { build } from 'esbuild';
   import { readFileSync, writeFileSync } from 'node:fs';
   await build({
     entryPoints: ['src/main.js'],
     outfile: 'bella-gif-helper.user.js',
     bundle: true,
     format: 'iife',
     target: 'es2022',
     minify: false,          // 绝对不要开
     legalComments: 'inline',
     charset: 'utf8',
     banner: { js: readFileSync('src/header.txt', 'utf8') },
     loader: { '.css': 'text', '.html': 'text' },  // 供 T7 使用
   });
   ```
4. `package.json` 加 `"build": "node build.mjs"`，`verify` 改为
   `npm run build && npm run check && npm test`
5. **产物仍然提交进仓库**（保持 R2 workflow 和「打开文件即可安装」的链接不变）。
   CI 增加防漂移检查：
   ```yaml
   - run: npm run build
   - run: git diff --exit-code -- bella-gif-helper.user.js
   ```
6. `.gitignore` 不要忽略产物。

**关键坑**
- esbuild 的 `format: 'iife'` 会自己包一层，所以 `src/main.js` 里**不要**再手写外层 IIFE，
  但要保留 `'use strict';`（esbuild 会保留顶部指令）
- `@resource` / `@grant` 全部靠 `header.txt` 原样输出，不能被 esbuild 当注释吃掉——
  用 `banner` 而不是写在 `main.js` 顶部
- 产物首次生成后，用 `node --check` + 47 个测试 + 全套手动冒烟验证一遍再提交

**验收**：`npm run build` 产出的脚本装进油猴后，冒烟清单全过。

**提交**：`build: introduce esbuild bundling with single-file output`（@version → 1.5.0）

---

## T7 · 抽出 1231 行模板

**问题**：`shadow.innerHTML` 的模板字符串横跨 L2248–L3479，共 **1231 行**
（1023 行 CSS + 208 行 HTML），夹在 `startApp` 正中间。这是「臃肿感」的最大来源，
且 CSS 完全享受不到编辑器高亮和校验。

**改动**

1. 建 `src/ui/panel.css`（把 `<style>` 里的 1023 行原样搬过去）和
   `src/ui/panel.html`（208 行 HTML 原样搬过去）
2. `src/ui/panel.js`：
   ```js
   import panelCss from './panel.css';
   import panelHtml from './panel.html';
   export const PANEL_TEMPLATE = `<style>${panelCss}</style>${panelHtml}`;
   ```
3. 主文件改成 `shadow.innerHTML = PANEL_TEMPLATE;`

**验收**
- `git diff` 里 CSS/HTML 内容应当逐字未变（用 `git diff --stat` 确认是移动而非重写）
- 面板外观与交互零差异，重点核对 `:host { all: initial }` 隔离仍然生效
- `startApp` 行数从 5405 降到约 4174

**提交**：`refactor: extract panel stylesheet and markup into modules`（@version → 1.5.1）

---

## T8 · 按边界拆分 startApp（分多次提交）

**顺序很重要**：先搬已被测试覆盖的部分（风险最低），最后搬 UI。

### T8.1 搬纯函数层（当前 L34–L2155，已被 47 个测试覆盖）

目标模块：
```
src/lib/geometry.js     calculateCropViewport / calculatePanelResize /
                        calculateInnerOverlayPosition / constrainPanelGeometry /
                        resizeSquareScreenRect / normalizeScreenRect ...
src/lib/format.js       formatFileSize / formatShortcut / formatGifFileName /
                        formatLiveGifFileName ...
src/lib/shortcut.js     DEFAULT_SHORTCUT / normalizeShortcut / matchesShortcut /
                        isEditableShortcutEvent / shortcutFromKeyboardEvent
src/live/mp4.js         parseLiveInit / parseLiveMedia / parseTrunDataLayout /
                        filterLiveInitToTrack / filterLiveMediaToTrack / rebaseLiveFragment
src/live/track.js       LiveRewindTrack
src/export/gif-presets.js  GIF_QUALITY_PRESETS / buildGifsicleCommand
src/errors.js           CancelledError
```

搬完后**删除 `tests/load-userscript-api.js` 的 vm hack**，测试改为直接
`require`/`import` 对应模块。`tests/*.test.js` 的断言内容不要改。

### T8.2 搬导出流水线
`src/export/`：`createExportFrameSourceFromMediaApi`、`createGifEncodingSession`、
`makeEncodingWorkerSource`、`generateGif`、`loadEncodingResourceTexts`、
`readUserscriptResource`、`loadExportMediaApi`。
注意 worker 源码是模板字符串拼出来的，搬运时保持字符串逐字不变。

### T8.3 搬直播采集与 iframe 通道
`src/live/`：`installLiveMediaCollector`、`installLiveFrameAgent`、`createLiveFrameClient`、
`getLiveRoomIdentity`、`extractLiveRoomId`。

### T8.4 搬录制
`src/record/`：`createCanvasRecording`、`createFrameCompositor`、`startRecording`、
`startRemoteRecording`、`beginRecordingSession`、`finalizeRecording`、`stopRecording`。

### T8.5 搬 UI
`src/ui/`：`editor.js`（裁剪 / 预览 / 视口动画）、`timeline.js`（时间轴与缩略图）、
`text-layers.js`（文字图层）、`panel-chrome.js`（悬浮球 / 面板拖拽缩放 / toast / status）。

### T8.6 收口 state 与 prefs
`src/state.js` 导出 `state` 单例（或工厂），`src/prefs.js` 放 T2 的统一存储。
`src/main.js` 最终只剩装配：建 shadow root、绑 `el`、注册事件、启动。

**每个子任务的硬性要求**
1. 只做移动 + 补 `import` / `export`，**不改任何一行逻辑**
2. 单独提交，commit message 前缀 `refactor:`
3. 提交前 `npm run verify` 全绿
4. T8.3 / T8.4 / T8.5 完成后各跑一遍完整手动冒烟清单
5. 每个子任务递增一次 `@version`（1.5.2 → 1.5.7）
6. 任何一步发现「不改逻辑就搬不动」，**停下来单独开一个 `fix:` / `refactor:` 提交处理，
   处理完再继续搬**

**最终目标**：`src/main.js` < 200 行；单个模块 < 600 行；`npm run build` 产物行为不变。

---

## 任务依赖与建议节奏

```
T0 (CI 关卡) ──┐
T1 (提交现有改动 + 文档) ──┤
                          ├──> T2 (统一存储) ──> T3 (日志) ──> T4 (rAF) ──> T5 (去重)
                          │                                                    │
                          └────────────────────────────────────────────────────┴──> T6 (构建) ──> T7 (模板) ──> T8.1…T8.6
```

- **T0 必须最先做**，否则后面每一次 push 都在无保护地推给正式用户
- T2–T5 之间没有强依赖，但按顺序做 diff 最干净
- **T6 之前工作区必须干净、测试全绿**
- T8 是长任务，允许跨多天；每个子任务都必须是可独立回滚的提交

## 不做的事

- 不做代码混淆 / 压缩（收益接近零，且会阻断 Greasy Fork 上架和自身调试）
- 不做「推倒重写」（仓库 11 天 64 个提交里有 25 个 `fix:`，
  大量 fMP4 字节解析、B 帧展示时序、WebCodecs 关键帧对齐的边界经验只存在于细节中，
  重写会原样丢失）
- 不引入前端框架、不引入 TypeScript（当前规模下收益不抵迁移成本，且 userscript 产物要保持可读）
- 不改 `@match` 列表、不改分发链路
