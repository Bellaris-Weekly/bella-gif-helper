# 同步与截图所有权调研

## 后续用户约束

- 用户已明确取消跨直播间即时同步；下文跨实例监听仅为历史调研备选，不纳入实现。
- 截图默认单键 P，其他可配置快捷键也支持单键。界面不解释双插件共享；所有新增或修改的用户可见文案必须事先逐条确认。

## 本地代码依据

- GIF：`src/live-screenshot.js` 的 `installLiveScreenshot` 在 documentElement 上同步声明 `data-bella-live-screenshot-installed`，抢到所有权才注册观察器与按钮处理。截图先同步 drawImage，再异步编码 PNG。
- Clip：`/srv/codex-workspaces/codex-project/bella-live-clip/bella-live-clip/src/ui/live-screenshot.js` 使用同一标记、相机子元素标记与 click capture 处理，文件为本地工作区版本，未核验部署版本。
- 两端现有截图函数都不要求 click.isTrusted，适合验证用已增强按钮 click 作为兼容入口。需浏览器实测下载用户激活行为。
- GIF 启动键默认 Ctrl+Z，Clip 启动键默认 Alt+Shift+C；均拒绝无 Ctrl/Alt/Meta 的普通按键，跳过输入区域、repeat 与 composition。
- GIF 截图先于顶层窗口 guard 初始化，活动页 iframe 不能遗漏。

## 外部依据

- Tampermonkey GM 存储和变更监听：https://www.tampermonkey.net/documentation.php?q=GM_values 。脚本存储不是不同 userscript 的自动共享配置。
- MDN storage event：https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event 。localStorage 的变更通知覆盖其他同源窗口，不发给修改所在窗口；跨域页面不能仅靠它同步。

## 候选方式

1. 同源共享 localStorage + 同页 DOM 通知：简单，覆盖普通直播页，但有站点数据清除、跨域与第三方 iframe 存储限制，不能直接宣称全局同步。
2. 各脚本 GM 持久化 + DOM 桥接 + 各脚本跨实例变更监听：保留跨域偏好；仍需桥接连接两脚本、记录变更版本与避免循环传播，停用期间未见过的更新需要重新会合才能同步。倾向此方向，待明确范围。
3. 外部同步服务：引入网络与维护成本，当前需求无需采用。

## 正确性要点

- 设置版本只在用户真正修改时生成，转发沿用原版本；默认值不能覆盖已保存修改，相同版本不得循环写入。
- 截图 owner 和快捷键 owner 分离：旧版先拿截图所有权时，新版仍可提供单一键盘入口并调用旧按钮。
- 同页只选择一个明确目标；iframe 请求需路由到选定 frame，不能广播让每个播放器都截图。
- 不靠延时去重，否则截图时机偏离用户按键时刻；截图失败也不让另一个插件盲目重试下载。
- 验证单装、双装、两种加载顺序、两种新旧组合、多个标签页、播放器重建、全屏、iframe 焦点、输入法和设置录制。
