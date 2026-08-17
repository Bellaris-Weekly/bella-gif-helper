# 贝报 GIF 助手

在哔哩哔哩视频页面中框选画面、录制片段并导出 GIF 的用户脚本。

## 功能

- 在视频页面框选需要录制的画面区域
- 录制最长 60 秒、最高 24 FPS 的视频片段
- 裁剪时间范围与画面比例，支持正方形预览
- 添加文字图层并调整字号、颜色、描边和位置
- 估算导出文件大小并生成 GIF
- 记住悬浮按钮和编辑面板的位置

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或其他支持用户脚本的浏览器扩展。
2. 打开 [beibao-gif-helper.user.js](beibao-gif-helper.user.js)。发布后也可以直接访问其 [原始文件](https://raw.githubusercontent.com/Bellaris-Weekly/beibao-gif-helper/main/beibao-gif-helper.user.js) 触发安装。
3. 将文件拖入扩展管理页面，或复制文件内容新建用户脚本并保存。
4. 打开支持的哔哩哔哩视频页面，点击右下角的贝报 GIF 助手按钮。

## 支持的页面

- `www.bilibili.com/video/*`
- `www.bilibili.com/list/*`
- `www.bilibili.com/bangumi/play/*`
- `www.bilibili.com/medialist/play/*`
- `www.bilibili.com/cheese/play/*`
- `m.bilibili.com/video/*`

## 使用说明

点击悬浮按钮后，在视频上拖动选择录制区域，确认后开始录制。录制结束会进入编辑界面，可以调整裁剪范围、添加文字，再点击生成 GIF 下载结果。

浏览器需要允许用户脚本在 B 站页面运行，并允许脚本加载 jsDelivr 上的 GIF.js 依赖。录制和编码过程会占用较多 CPU 与内存，片段越长、分辨率越高，生成时间和文件大小越大。

## 依赖与许可证

本项目以 MIT 许可证发布，详见 [LICENSE](LICENSE)。GIF 编码使用 [gif.js 0.2.0](https://github.com/jnordberg/gif.js)，同样以 MIT 许可证发布，并通过 jsDelivr 加载。

## 反馈

请在 GitHub Issues 中提交可复现的问题，并附上浏览器、用户脚本管理器和 B 站页面类型等信息。
