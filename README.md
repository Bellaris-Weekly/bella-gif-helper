# 贝报 GIF 助手

在哔哩哔哩直播或视频页面中截取画面、编辑片段并导出 GIF 的用户脚本。当前版本为 `1.4.1`。

## 功能

- 在视频页面框选需要录制的画面区域
- 在直播页面点击后立即剪辑此前 60 秒的画面
- 直播剪辑页可切换“回溯”和“录制”
- 录制最长 60 秒、最高 24 FPS 的视频片段
- 裁剪时间范围与画面比例
- 桌面端可拖动悬浮窗的四边和四角调整尺寸，并跨页面、跨版本记住窗口位置与大小
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

直播页首次默认使用“回溯”：脚本进入页面后在内存中保留最近 75 秒的视频分片，点击悬浮按钮会立即打开此前最多 60 秒的可解码画面。预热不足 60 秒时会使用当前已有片段；尚未收到关键帧时会提示继续预热。剪辑时间轴下方可以切换为“录制”，切换后会停止保留回溯分片并释放对应内存；再次切回后需要重新预热。

进入编辑界面后，可以调整时间与画面裁剪、添加文字，并实时查看分辨率、帧率、速度和圆角效果，再点击“导出 GIF”下载结果。画质档位只调整调色板、抖动和压缩强度，不会改动用户选择的分辨率、帧率、时长或播放速度。

- `乃 · 高画质`：255 色、误差扩散抖动和无损结构优化。
- `贝 · 均衡`：255 色和轻度有损压缩，默认选择。
- `然 · 体积优先`：192 色和更高压缩强度。

浏览器需要允许用户脚本在 B 站页面运行，并允许脚本加载 jsDelivr 上的 modern-palette、gifenc 和 Gifsicle WASM 依赖。运行基线为支持 `VideoFrame`、`OffscreenCanvas` 和模块 Worker 的现代 Chromium。

导出时会使用独立视频源，只处理时间选区内的目标帧，并按设备核心数启用 2 至 4 个编码 Worker。编码队列满时取帧暂停，避免越过裁剪终点。文件大小通过选区内连续画面的真实编码与压缩结果估算；后台时间轴预览缓存固定在 32 MB 预算内，仅服务编辑预览。

直播回溯只缓存视频，不缓存音频，也不会调用 B 站私有剪辑接口。75 秒缓存按直播码率占用内存：2 Mbps 约 19 MB，8 Mbps 约 75 MB。

## 反馈

请在 GitHub Issues 中提交可复现的问题，并附上浏览器、用户脚本管理器和 B 站页面类型等信息。

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

## 第三方编码组件

- `modern-palette 2.0.0`：MIT License。
- `gifenc 1.0.3`：MIT License。
- `gifsicle-wasm-browser 1.5.19`：封装层为 MIT License，内含的 Gifsicle 压缩核心为 GPL-2.0-or-later。
