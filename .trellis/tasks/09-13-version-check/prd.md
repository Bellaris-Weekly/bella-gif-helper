# 标题版本号与静默更新检查

## Requirements
- 标题旁紧凑显示当前版本，从元数据头构建注入，保持版本唯一来源。
- 主页面启动静默检查一次；点击版本号主动检查，检查期间合并重复请求。
- 有新版显示红点和细红框，点击打开既有 downloadURL 的脚本管理器安装页。
- 不弹窗，不打断编辑；手动检查结果通过版本按钮提示显示；网络失败可重试。
- 检查只解析元数据，绝不执行远程代码；不改变分发通道或媒体逻辑。

## Acceptance
- 覆盖数字版本、预发布、同版本、旧版本、无效响应、网络失败与重复点击。
- 验证标题布局和点击状态；npm run verify。
- 发布前完整人工冒烟清单，无法完成不得推送 main。

## Research
Tampermonkey documentation https://www.tampermonkey.net/documentation.php documents GM_xmlhttpRequest, GM_openInTab, @connect. Use manager cross-origin request and existing installation URL. No change to update/download destination.

## Verification result
- npm run verify: 52/52 passed; build, syntax and version consistency passed.
- Local browser preview: neutral state, red update badge, click dispatch, failure/retry, 290px title layout verified. Transport and installation replaced by test doubles in preview.
- Production endpoint read-only fetch: parses version 1.5.9.
- Release remains pending: actual userscript manager install, Bilibili video/live/iframe export smoke and 1.4.x profile migration not verified. Do not push main before completion.
