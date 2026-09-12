# 第三方组件声明

本文件记录贝报 GIF 助手在运行时加载的第三方组件及其许可证义务。

## 分发方式说明

本项目**不复制、不内联、不自行托管**这些组件。`bella-gif-helper.user.js` 只通过
`@resource` 元数据发布各组件在 jsDelivr（npm 镜像）上的地址，由用户浏览器在安装
和运行时自行下载。这些组件的分发者是各自的上游作者与 jsDelivr，不是本项目。

因此，各上游许可证中与「分发」相关的义务（保留声明、提供源码、copyleft 传染）
目前**不由本项目承担**，但本文件仍完整记录，以便：

1. 用户知晓脚本实际会加载哪些代码；
2. 一旦分发方式改变，能立刻判断需要做什么。

**一旦改为自行托管或内联这些组件，本项目的许可证必须随之调整。** 详见
[`AGENTS.md`](AGENTS.md) 的红线一节。

## 组件清单

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| [Mediabunny](https://github.com/Vanilagy/mediabunny) | 1.55.3 | MPL-2.0 | 媒体解复用与解码调度 |
| [Gifsicle](https://github.com/kohler/gifsicle)（WebAssembly 构建） | 见下 | **GPL-2.0-only** | GIF 后压缩 |
| ↳ 经由 [gifsicle-wasm-browser](https://github.com/renzhezhilu/gifsicle-wasm-browser) | 1.5.19 | 封装层 MIT | 提供浏览器端调用入口 |
| [gifenc](https://github.com/mattdesl/gifenc) | 1.0.3 | MIT | GIF 编码 |
| [modern-palette](https://github.com/qq15725/modern-palette) | 2.0.0 | MIT | 调色板量化 |

对应的 `@resource` 地址固定在 `src/header.txt`，不随依赖自动升级。

## Mediabunny 1.55.3 — MPL-2.0

- 版权：Mediabunny contributors
- 许可证全文：<https://www.mozilla.org/en-US/MPL/2.0/>
- 源码：<https://github.com/Vanilagy/mediabunny>
- 本项目加载的地址：`https://cdn.jsdelivr.net/npm/mediabunny@1.55.3/+esm`

MPL-2.0 是**文件级** copyleft。义务要点：

- 若分发该组件的可执行形式，须同时告知接收者如何获取其源码；
- 若修改了受 MPL 覆盖的文件，被修改的文件须继续以 MPL-2.0 发布；
- 不得移除或更改组件内的许可证声明。

**本项目未修改 Mediabunny 的任何文件**，也未分发它。上游 npm 包内含完整
`LICENSE` 与未压缩的模块源码，源码获取义务已由上游履行。

## Gifsicle（WebAssembly 构建）— GPL-2.0-only

- 版权：Copyright (C) 1997-2025 Eddie Kohler
- 许可证全文：<https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>
- 源码：<https://github.com/kohler/gifsicle>
- 本项目加载的地址：`https://cdn.jsdelivr.net/npm/gifsicle-wasm-browser@1.5.19/dist/gifsicle.min.js`

**版本判定依据**：Gifsicle 上游 README 的 Copyright/License 一节明确写着
“distributed under the GNU General Public License, Version 2 **(and only
Version 2)**”，并另附一条需联系作者才能使用的替代许可。因此 SPDX 标识为
`GPL-2.0-only`，**不是** `GPL-2.0-or-later`。

这一点有实际后果：`GPL-2.0-only` 与 `GPL-3.0` 不兼容，不能通过升级许可证版本来
化解与其它协议的冲突。

GPL-2.0 的 copyleft 作用于整个「基于该程序的作品」。义务要点：

- 若分发该组件的可执行形式，整个作品必须以 GPL-2.0-only 发布；
- 必须随附完整许可证文本；
- 必须随附或提供对应的完整源码。

**上游存在声明缺陷，请注意**：`gifsicle-wasm-browser` 的 `package.json` 与包内
`LICENSE` 只声明了封装层的 MIT，包内既没有 GPL 声明，也没有 `COPYING` 文件，
而 `dist/gifsicle.min.js`（334 KB）已经把 GPL-2.0-only 的 Gifsicle 编译为
WebAssembly 并以 base64 内嵌其中。因此**不能依据该包的 MIT 声明来判断其整体
许可证**——它内嵌的 Gifsicle 部分仍然是 GPL-2.0-only。

本项目通过 CDN 引用该产物，未复制其内容，故未承担上述义务；但**只要把这个文件
搬进本仓库或本项目自己的对象存储，本项目立刻成为 GPL-2.0-only 作品的分发者**。

## gifenc 1.0.3 — MIT

- 版权：Copyright (c) 2018 Matt DesLauriers
- 源码：<https://github.com/mattdesl/gifenc>
- 本项目加载的地址：`https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js`

MIT 的义务只有一条：在软件的所有副本或实质性部分中，保留版权声明与许可声明。

```
MIT License

Copyright (c) 2018 Matt DesLauriers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## modern-palette 2.0.0 — MIT

- 版权：Copyright (c) 2022-present qq15725
- 源码：<https://github.com/qq15725/modern-palette>
- 本项目加载的地址：`https://cdn.jsdelivr.net/npm/modern-palette@2.0.0/dist/index.mjs`

MIT 的义务同上：保留版权声明与许可声明。

```
MIT License

Copyright (c) 2022-present qq15725

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 版本核对记录

以上版本、许可证标识与 CDN 地址于 2026-09-12 通过 npm registry、jsDelivr 包文件
清单与各上游仓库核对。升级 `@resource` 里的依赖版本时，须同步复核本文件。
