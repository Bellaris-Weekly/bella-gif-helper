# 项目工作约定

面向在本仓库工作的 AI Agent 与维护者。**读完再动手。**

## 项目结构

单文件用户脚本。源码在 `src/`，`bella-gif-helper.user.js` 是 esbuild 构建产物
（仍然提交进仓库，供直接安装与 R2 分发）。

```
src/main.js          主体逻辑
src/header.txt       ==UserScript== 元数据头（@version 的唯一真实来源）
src/ui/panel.{css,html,js}   面板样式与结构
scripts/build.mjs    构建
scripts/check-version.mjs    版本号一致性校验
tests/               测试与真实媒体素材
```

## 提交与发布

- 完成代码修改并通过验证后，立即提交并推送到当前分支的远程仓库。
- 改动 `bella-gif-helper.user.js` 时，推送前递增 `src/header.txt` 的 `@version`，
  并同步 README 的版本号（`check:version` 会强制校验）。只改 CI 或文档时不递增。
- 提交标题必须是英文，且以 `fix:` / `feat:` / `refactor:` / `docs:` / `test:` 开头；
  正文需包含 `说明：` 段落（`commit-msg` 钩子会拦截）。
- 每次提交前必须通过：
  ```bash
  npm run verify   # build + node --check + check:version + 47 个测试
  ```

### 发布通道：main 即正式发布

`@updateURL` 与 R2 同步共用同一个 key，**push 到 main 的每一次提交都会通过
自动更新推送给全部安装用户**。版本号里的后缀只是命名，不影响分发范围。
这是维护者知情后的决定，不要再提议拆分 beta / stable 通道。

**因此没有灰度缓冲，合并到 main 之前的验证就是唯一防线**：
`npm run verify` 全绿 + 完整跑一遍下面的冒烟清单，两者缺一不可。
`sync-r2.yml` 里 upload job 的 `needs: test` 不得放宽或绕过。

## 手动冒烟清单

自动化测试只覆盖纯函数层，下面这些路径一个都够不着。
**任何结构性改动或发布前必须人工跑完：**

- [ ] 视频页（`www.bilibili.com/video/*`）：框选 → 录制 → 编辑 → 导出 GIF
- [ ] 直播页回溯模式：点击悬浮球 → 拿到此前 60 秒 → 导出
- [ ] 直播页切换到录制模式 → 录制 → 导出
- [ ] 活动页 iframe 直播（`live.bilibili.com/blanc/*`）能正常框选与录制
- [ ] 文字图层：新增 / 拖动 / 删除 / 切换标签
- [ ] 时间轴：拖动起止点、缩略图刷新、拖完聚焦
- [ ] 面板拖拽与四边缩放，刷新后位置尺寸保持
- [ ] 快捷键 `Ctrl+Z` 启动；焦点在评论框时不劫持原生撤销
- [ ] 1:1 开关关闭后刷新页面仍为关闭
- [ ] 用装过 1.4.x 的浏览器 profile 升级，确认快捷键、悬浮球位置、导出档位、
      1:1 开关全部完整迁移

## 红线

- 不改动 GIF 调色 / 编码 / 解码算法：`createGifEncodingSession`、
  `makeEncodingWorkerSource`、`createExportFrameSourceFromMediaApi`、
  `LiveRewindTrack` 及 fMP4 解析函数。这些是踩了 20 多个 bug 才稳下来的。
- 不升级、不替换 `@resource` 里的四个依赖版本。
- 不对产物做混淆或压缩（收益接近零，且会阻断上架与调试）。
- 不改 `@match` 列表、不改分发链路。
- 不把 `@resource` 里的四个依赖自托管、镜像或内联进产物（见下节「许可边界」）。
- `makeEncodingWorkerSource()` 模板字符串里的 `catch (_) { }` **保持原样**——
  那段代码运行在 Worker 上下文，`debugLog` 不存在。

## 许可边界

本仓库自有代码是 MIT（`LICENSE`），但产物运行时会加载 GPL-2.0-only 与 MPL-2.0 代码
（清单见 `THIRD-PARTY-NOTICES.md`）。**MIT 之所以成立，只因为本项目不复制、不托管
这些组件**——`@resource` 只发布 jsDelivr 地址，由用户浏览器自行下载，分发者是上游
与 CDN，不是本项目。

以下动作会把本项目从「聚合分发」变成「分发 GPL 作品」，一旦发生，**整个
`bella-gif-helper.user.js` 必须改为以 GPL-2.0-only 发布**，`LICENSE`、`src/header.txt`
的 `@license`、README 与 `package.json` 需同步改写：

- 把 `dist/gifsicle.min.js` 或任何 Gifsicle 构建产物镜像到本项目使用的对象存储；
- 把上述组件内联、打包进 `bella-gif-helper.user.js`（包括为「离线可用」而内联）；
- 把依赖换成本项目自行编译的 Gifsicle 构建产物。

另外两条：

- Gifsicle 是 **GPL-2.0-only**，不是 `-or-later`。不要在任何文档里写成可升级到
  GPL-3.0，也不要指望靠升级许可证版本化解冲突。
- `gifsicle-wasm-browser` 的 `package.json` 只声明封装层 MIT，包内没有 GPL 声明与
  `COPYING`，但 `dist/gifsicle.min.js` 已把 GPL-2.0-only 的 Gifsicle 编译为 WASM
  并以 base64 内嵌。**不要以该包的 MIT 声明推断其整体许可证。**

升级 `@resource` 依赖版本时，必须同步复核 `THIRD-PARTY-NOTICES.md` 中的版本、
许可证标识与源码地址。

## 已知缺口

`parseLegacyPref()` / `migrateLegacyPrefs()` 没有单元测试。
**偏好迁移出错是静默失败**——用户设置丢了不会报错、也不会有人反馈。
在补上测试之前，每次改动偏好相关代码都必须手工验证一次「1.4.x profile 升级」这条路径。

## 关于重构

`startApp` 是一个 4200+ 行的函数。**不要主动提议把它拆开。**

2026-09-04 评估过：仓库零死函数、零死常量、资源释放全部成对，巨型函数目前
没有在制造 bug；拆分对用户收益为零，唯一实质收益是可测性，而拆分本身就是在
没有测试的情况下改动这些代码——风险在前、收益在后。

出现下列任一情况时再重新评估：

- 项目多了第二个开发者
- 维护者开始不敢碰文件里的某一块
- 某一类 bug 在同一区域反复出现（此时抽出该区域 + 补测试）
- 执行 Agent 因为单文件上下文过长开始改错东西

在那之前，需要测某段逻辑时**只抽出那一段**，由测试驱动，不做整体重排。
完整的历史评估见 git 历史中的 `OPTIMIZATION_PLAN.md`（提交 `e5cbd73` 及之前）。
