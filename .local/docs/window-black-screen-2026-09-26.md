# 0.1.2 启动后窗口黑屏排查

用户确认：仅 LumaShift 窗口内容变黑，其他应用正常，托盘可以退出。不是整台显示器变黑。

现有证据：两次启动 22:17:29 / 22:18:00 均记录 worker ready；进程为 0.1.2、Windows Responding=true、WebView2 子进程存在；未查到当时相关 Application 日志 1000/1001/1002 事件。配置的 applyLastOnStart=false，三个已保存 Profile 的硬件参数均为空。旧日志没有前端异常信息，无法据此认定具体原因，不能声称已经复现或修复根因。

## 0.1.3 诊断和恢复能力

- 记录版本、进程、启动检测阶段、自动应用决策、前端脚本启动、状态订阅/获取、首个界面挂载。
- 记录操作开始/结束、快捷键来源、耗时、Gamma 写入/恢复。
- React 错误边界显示可重载的错误页；捕获窗口错误、未处理 Promise 错误并写入原生日志。
- WebView2 ProcessFailed 监听从原生侧记录渲染进程故障，即使 JS 已经无法执行仍可提供诊断。
- 托盘提供“重新加载界面”，仅重载前端，不重启显示控制引擎或改变硬件参数。
- `--software-rendering` 仅为诊断开关，在当前进程启用 WebView2 `--disable-gpu`；默认渲染方式不变，不修改 Windows/驱动设置。若兼容方式恢复正常，只说明 GPU 渲染路径值得继续检查，不能据此确认驱动故障。
- HTML 在脚本加载前显示启动占位文字；React 异常回归页位于 [ui-error-check.html](review-evidence/ui-error-check.html)。

本轮不启动真实桌面应用，不改动用户屏幕或配置；根因待新诊断日志及用户实际复现确认。

验证：28 项 Rust 测试、TypeScript/Vite、Tauri release 构建及 diff 检查通过。浏览器主动触发渲染异常，确认显示错误页，点击重新加载后恢复测试界面。此验证不等于复现用户的黑屏原因。

产物：`.local/artifacts/LumaShift-0.1.3.exe`；备用软件渲染入口：`.local/artifacts/LumaShift-0.1.3-software.cmd`。运行前需退出旧版，避免单实例逻辑仅激活已运行的旧进程。

参考：[Microsoft WebView2 进程故障事件](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-related-events)、[WebView2 诊断开关](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags)。
