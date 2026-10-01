# LumaShift

Windows SDR 画面调节工具，支持 Gamma 曲线、饱和度、预设和全局快捷键。

基于 Tauri 2、Rust、React 和 TypeScript 构建。

## 功能

- **画面调节**：Gamma、暗部提升、对比度、饱和度、高光、曝光、色温倾向和黑位提升。
- **预设管理**：新建、保存、重命名、删除，支持 JSON 导入与导出。
- **全局快捷键**：切换预设、开关效果，支持自定义 F 键及组合键。
- **实时预览**：调整即时生效，支持当前修改与已保存效果对比，首次保存前对比原始画面。
- **托盘常驻**：关闭窗口后继续保持效果和快捷键。
- **主题与语言**：浅色、深色、跟随系统；简体中文、English。

## 使用

运行环境：Windows x64、SDR 显示模式、WebView2 Runtime。

饱和度范围 0–200，100 为原色，作用于所有屏幕。独占全屏或帧生成场景可能不兼容，设回 100 即可停用。

运行构建好的 EXE 后：

1. 选择预设，开启效果。
2. 调整画面参数。
3. 点击“保存预设”。在预设名称旁点击快捷键按钮，即可按键设置切换按键；退格或 Delete 清除，Esc 取消录入。也可在“设置 → 快捷键”中统一管理。

| 动作 | 默认快捷键 |
| --- | --- |
| 桌面预设 | F6 |
| 开关效果 | F9 |
| 循环切换预设 | F10 |

首次启动仅提供桌面预设，不预置游戏预设；已有配置、预设及快捷键保持不变。

点击窗口 **×** 默认隐藏到托盘，可在设置中改为退出程序。托盘菜单也提供“恢复并退出”。关闭效果或正常退出时，程序会尝试恢复调整前的 Gamma 设置。

更新前需先从托盘退出旧实例，再运行新版。

## 开发

需要 Node.js 与 npm、Rust 1.88+（MSVC 工具链）、Visual Studio C++ 桌面开发工具、Windows SDK 和 WebView2 Runtime。

```powershell
npm.cmd ci
npm.cmd run desktop
```

仅预览前端界面：

```powershell
npm.cmd run dev
```

访问 `http://127.0.0.1:1420/`。浏览器预览使用模拟数据，不控制真实显示器。两种开发模式共用 1420 端口，请分别运行。

## 构建与测试

```powershell
# 构建 Windows EXE
npm.cmd run desktop:build

# 前端类型检查与构建
npm.cmd run build

# 前端交互行为测试
npm.cmd test

# Rust 单元测试
npm.cmd run test:rust
```

本地构建产物：`.local/builds/LumaShift-0.1.1-<时间戳>.exe`。每次构建生成新文件，可避免旧实例占用 EXE 导致构建失败。请运行该目录中的产物，不要直接运行编译缓存目录中的 EXE。切换到新版前仍需从托盘退出旧实例。

## 发布

先推送代码，再单独推送与项目版本一致的 tag，自动构建并发布 Windows x64 EXE：

```powershell
git push origin main
git tag v0.1.1
git push origin v0.1.1
```

Release 附件为 `LumaShift-0.1.1-windows-x64.exe`。版本号由维护者指定，工作流不会自动修改；tag 与项目版本不一致时停止发布。

## 配置与日志

数据目录：`%APPDATA%\app.lumashift.desktop`，可从设置页的“日志”按钮打开。

## 许可证

[MIT License](LICENSE)
