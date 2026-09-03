# 贝报 GIF 助手

在哔哩哔哩直播或视频页面中截取画面、编辑片段并导出 GIF 的用户脚本。当前版本为 `1.5.2-beta`。

## 功能

- 在视频页面框选需要录制的画面区域
- 默认按 `Ctrl+Z` 即可启动，也可在编辑面板顶部修改快捷键
- 在直播页面点击后立即剪辑此前 60 秒的画面
- 直播剪辑页可切换“回溯”和“录制”
- 录制最长 60 秒、最高 24 FPS 的视频片段
- 裁剪时间范围与画面比例
- 桌面端可拖动悬浮窗的四边和四角调整尺寸，并跨页面、跨版本记住窗口位置与大小
- 记住 1:1 裁剪开关的状态，关掉后再开新片段不会被强制拉回方形
- 添加文字图层并调整字号、颜色、描边和位置
- 实时预览导出分辨率、帧率和播放速度
- 通过“乃 / 贝 / 然”三档控制 GIF 画质
- 导出透明圆角 GIF
- 使用选区调色板、并行编码和后压缩缩短导出时间并减少 GIF 体积

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或其他支持用户脚本的浏览器扩展。
2. 打开 [bella-gif-helper.user.js](bella-gif-helper.user.js)。也可以直接点击 [立即安装](https://share.bellaris.fans/bella-gif-helper.user.js) 。
3. 将文件拖入扩展管理页面，或复制文件内容新建用户脚本并保存。
4. 打开支持的哔哩哔哩视频页面，点击右下角的贝报 GIF 助手按钮。 https://i0.hdslb.com/bfs/garb/item/70de4619ce5e8a7b5bbe5c4124aa69353d8102e4.png

## 支持的页面

- `www.bilibili.com/video/*`
- `www.bilibili.com/list/*`
- `www.bilibili.com/bangumi/play/*`
- `www.bilibili.com/medialist/play/*`
- `www.bilibili.com/cheese/play/*`
- `m.bilibili.com/video/*`
- `live.bilibili.com/*`

## 使用说明

普通视频页点击悬浮按钮后，在视频上拖动选择录制区域，确认后开始录制。

也可以按 `Ctrl+Z` 直接执行与悬浮按钮相同的操作。编辑面板顶部会直接显示当前快捷键，点击快捷键框后按下新的组合键即可保存。焦点位于搜索框、评论框或文字编辑框时，快捷键不会拦截页面原有的撤销操作。

悬浮球位置、导出档位（帧率 / 画质 / 圆角）、1:1 裁剪开关和直播采集模式统一存在一处，在 `www`、`live`、`m` 三个子站之间共享；升级前已有的设置会在首次读取时自动迁移，且不会被删除。

直播页首次默认使用“回溯”：脚本进入页面后在内存中保留最近 75 秒的视频分片，点击悬浮按钮会立即打开此前最多 60 秒的可解码画面。预热不足 60 秒时会使用当前已有片段；尚未收到关键帧时会提示继续预热。剪辑时间轴下方可以切换为“录制”，切换后会停止保留回溯分片并释放对应内存；再次切回后需要重新预热。

进入编辑界面后，可以调整时间与画面裁剪、添加文字，并实时查看分辨率、帧率、速度和圆角效果，再点击“导出 GIF”下载结果。画质档位只调整调色板、抖动和压缩强度，不会改动用户选择的分辨率、帧率、时长或播放速度。
拖动时间轴起点或终点并松手后，时间轴会聚焦当前选区，并在两端保留少量相邻画面。需要重新扩大选区时，可按当前时间尺度继续向外线性拖动端点。

- `乃 · 高画质`：256 色调色板、误差扩散抖动和无损结构优化。
- `贝 · 均衡`：256 色调色板和轻度有损压缩，默认选择。
- `然 · 体积优先`：256 色调色板和更高压缩强度。

三档均使用 GIF 完整的 256 项调色板，其中 1 个索引保留给透明像素；档位之间不再缩减颜色数量。

浏览器需要允许用户脚本在 B 站页面运行，并允许脚本加载 jsDelivr 上的 Mediabunny、modern-palette、gifenc 和 Gifsicle WASM 依赖。运行基线为支持 `VideoDecoder`、`VideoFrame`、`OffscreenCanvas` 和模块 Worker 的现代 Chromium。

导出时，录制得到的 WebM 和直播回溯得到的 fMP4 都通过同一套 Mediabunny + WebCodecs 帧源顺序解码。直播 B 帧素材的选区和取帧统一按展示时间计算，即使缓存从 GOP 中途开始也会从首个实际可展示的关键帧导出。导出不会操作播放进度或依赖屏幕刷新率；编辑预览仍使用 MediaSource。单路解码与并行编码 Worker 之间使用背压限制在途帧数，并为主线程和解码各保留一个处理核心。导出前显示的体积是基于画面颜色复杂度和运动复杂度的经验估算，可能存在约 30%～50% 误差，导出完成后会替换为实际大小；后台时间轴预览缓存固定在 32 MB 预算内，仅服务编辑预览。

直播回溯只缓存视频，不缓存音频，也不会调用 B 站私有剪辑接口。75 秒缓存按直播码率占用内存：2 Mbps 约 19 MB，8 Mbps 约 75 MB。

活动页直播播放器通常嵌在 `live.bilibili.com/blanc/*` iframe 中。脚本会在顶层页面保留编辑器，在播放器 iframe 内安装捕获代理；两层通过受限的同源 `postMessage` 通道交换画面坐标、回溯快照和录制结果。父页负责框选与编辑，iframe 负责读取真实视频并录制，跨页面切换或播放器重建时会自动重新发现视频。

## 反馈

请在 GitHub Issues 中提交可复现的问题，并附上浏览器、用户脚本管理器和 B 站页面类型等信息。

脚本内部有大量「失败即静默」的兜底分支，默认不会往控制台输出任何内容。排查问题时可以打开调试日志：在脚本管理器的控制台中执行

```js
GM_setValue('biliGifMakerDebugV1', true)
```

然后刷新页面，控制台会打印形如 `[bella-gif][作用域名称] 错误对象` 的告警。排查结束后执行 `GM_setValue('biliGifMakerDebugV1', false)` 关闭。

## 开发验证

运行语法检查与完整测试集：

```bash
node --check bella-gif-helper.user.js
node --test tests/*.test.js
```

透明圆角 GIF 可使用 Pillow 逐帧检查：

```bash
python3 tests/check_gif_transparency.py output.gif --radius-ratio 0.04 --expected-delay 80
```

导出帧与同尺寸 sRGB 参考图可使用 Pillow 检查整体色差和黄色方向偏移：

```bash
python3 tests/check_gif_color.py reference.png output.gif
```

## 第三方媒体组件

- `Mediabunny 1.55.3`：MPL-2.0 License。
- `modern-palette 2.0.0`：MIT License。
- `gifenc 1.0.3`：MIT License。
- `gifsicle-wasm-browser 1.5.19`：封装层为 MIT License，内含的 Gifsicle 压缩核心为 GPL-2.0-or-later。
