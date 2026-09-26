# LumaShift 技术选型

状态：已采用并创建工程。记录日期：2026-09-26。

## 已确认的偏好

- 用户明确排除 C#，不熟悉该语言。
- 用户熟悉 Python / Rust，前端偏好 TypeScript / Node.js 生态。
- 不强制使用 Rust，希望避免不必要的工程复杂度。
- 初版需求见 [mvp.md](mvp.md)。

## 当前实现

| 部分 | 建议技术 | 用途 |
| --- | --- | --- |
| 桌面应用框架 | Tauri 2 | 窗口、托盘、应用生命周期与前后端通信 |
| 用户界面 | React + TypeScript + Vite | 滑块、预设管理、快捷键设置和设备状态 |
| 显示控制与应用状态 | Rust | 调节请求协调、基线管理、恢复流程、预设持久化 |
| Windows 接口 | Microsoft `windows` crate | Gamma、DDC/CI、显示设备枚举等系统调用 |
| 全局快捷键 | Tauri 官方 global-shortcut 插件 | 可配置单个 F 键或组合键，在 Rust 端响应直接选择预设、循环切换及开关效果 |
| 本地数据 | 带格式版本的 JSON，使用 serde / serde_json | 预设与设置；写入采用可恢复的文件替换流程 |

当前使用上述组合。npm 依赖版本由 package-lock.json 锁定，Rust 依赖版本由 src-tauri/Cargo.lock 锁定；运行和验证方式见 [development.md](development.md)。

## Node.js 与 Rust 的分工

Node.js 用于安装前端依赖、运行 Vite 开发服务器及构建前端资源。正式应用通过 Windows WebView2 展示界面，由 Rust 调用系统接口；本方案不依赖独立的 Node.js 业务服务。

Rust 的范围应集中在系统控制与应用状态：曲线计算、显示器操作、请求调度、预设读写及恢复。界面布局、交互表现和表单编辑使用 TypeScript。

## 实现约定

- Rust 保存当前实际应用状态；前端维护尚未保存的编辑草稿，并接收应用结果。
- 前端只发送明确的操作请求，不直接操作显示设备句柄或系统 DLL。
- 阻塞的 Gamma / DDC 调用放到后台执行，对同一设备的写入按顺序处理，并合并尚未执行的连续调节请求。
- 只合并队列中相邻的预览请求；关闭、退出、切换和快捷键作为不可跨越的顺序边界。关闭效果后到达的预览只更新草稿，不写显示器。
- 托盘与快捷键的执行逻辑位于 Rust 端，不依赖界面可见或前端计时器持续运行。
- 快捷键持久化保存为动作与按键的绑定；每个预设用稳定 ID 关联，注册失败时反馈冲突，不把游戏内部键位当成已被系统检测。
- DDC 后端包含设备支持时的硬件饱和度控制，使用能力与当前值查询判断可用性；其他色彩控制项按设备能力扩展。
- 正常退出恢复、异常终止恢复、显示器断开后的处理分别设计和验证，不把后台任务误认为独立的恢复守护进程。
- 初版将 UI、控制逻辑和 Windows 接口分成代码模块，通过 Tauri commands/events 通信。

## 取舍

- Tauri 可以继续使用 TypeScript 前端，同时通过 Rust 对接 Windows；代价是维护两种语言以及接口数据结构。
- Rust 工程与 Win32 互操作确实有学习、编译和调试成本；使用 Rust 不等于需要引入复杂的服务架构。
- Electron + TypeScript + FFI 是更偏向 JS/TS 的替代方案，但仍需维护系统接口绑定及原生依赖打包；Electron 自带 Chromium 与 Node.js。
- Python 可以通过 ctypes 调用 Windows DLL；若与 Web 前端组合，还需选择桌面宿主并处理托盘、快捷键及打包。本项目用户已熟悉 Rust，因此当前优先考虑 Tauri。
- 包体、启动速度与托盘常驻资源占用需要用实际构建测量，不预先承诺固定数值。

## 本机环境初步检查

- 已找到 Rust 1.92.0，当前工具链为 stable-x86_64-pc-windows-msvc。
- 已找到 Node.js v24.12.0、npm 和 Git。
- 使用 Visual Studio 18 Insiders 中的 MSVC 14.51 与 Windows SDK 10.0.26100.0；脚本包含 prerelease Visual Studio 检测。
- 本机已安装 WebView2 153.0.4234.48。
- 前端生产构建、Rust 编译与单元测试已通过，已生成 Windows x64 可执行文件。
- 本机 P275MS PLUS 已完成只读枚举、Gamma 读取及 DDC/CI 能力读取；未修改真实显示器参数。

## 参考

- [Tauri Windows 开发依赖](https://v2.tauri.app/start/prerequisites/)
- [Tauri 架构](https://v2.tauri.app/concept/architecture/)
- [Tauri 托盘](https://v2.tauri.app/learn/system-tray/)
- [Tauri 全局快捷键](https://v2.tauri.app/plugin/global-shortcut/)
- [Microsoft Rust for Windows](https://github.com/microsoft/windows-rs)
- [Electron 简介](https://www.electronjs.org/docs/latest/)
- [Koffi：Node.js FFI](https://koffi.dev/)
- [Python ctypes](https://docs.python.org/3/library/ctypes.html)
