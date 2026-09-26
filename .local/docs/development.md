# LumaShift 本地开发

2026-09-26，Windows SDR 初版 0.1.0。需求见 [mvp.md](mvp.md)，技术选型见 [technical-selection.md](technical-selection.md)。

## 运行与构建

在项目根目录执行：

```powershell
npm.cmd ci
npm.cmd run desktop
```

桌面脚本自动加载 MSVC 环境，兼容本机 Visual Studio Insiders。需要 Node.js、Rust MSVC 工具链、Windows SDK 和 WebView2。本机已具备这些依赖。

```powershell
# 只看界面：独立的模拟设备与 localStorage，不访问显示接口
npm.cmd run dev

# 前端类型检查和生产资源
npm.cmd run build

# Rust 单元测试
npm.cmd run test:rust

# 原生编译检查
powershell -ExecutionPolicy Bypass -File scripts/desktop.ps1 check

# 只读检测真实显示器；不写 Gamma 或 VCP
powershell -ExecutionPolicy Bypass -File scripts/desktop.ps1 diagnose

# Windows x64 release，前端内嵌，无需 Vite 服务
npm.cmd run desktop:build
```

`npm run dev` 与 `npm run desktop` 共用 1420 端口，运行其中一个即可。前者的模拟预设、演示饱和度与设置不会同步到原生程序。关闭网页不涉及真实显示恢复。

构建输出：`src-tauri/target/release/lumashift.exe`。本次便于试用的副本放在 `.local/artifacts/LumaShift-0.1.0.exe`。依赖系统 WebView2，不需要安装 Node.js 或 Rust；首版未做安装包、签名或自动更新。

如已有自动应用偏好，但需要临时以不应用效果的方式启动：

```powershell
$env:LUMASHIFT_SAFE_START = '1'
& .\src-tauri\target\release\lumashift.exe
Remove-Item Env:LUMASHIFT_SAFE_START
```

环境变量只影响本次进程的启动应用行为，不阻止之后主动开启效果。若已有实例，单实例逻辑只唤出原窗口，需先退出原实例再使用。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| src/App.tsx、styles.css | 调节、预设、快捷键、设置界面 |
| src/bridge.ts | Tauri 通信及浏览器模拟模式 |
| src/types.ts | 前端消息类型、曲线示意与按键格式 |
| src-tauri/src/model.rs | 配置格式、参数范围和导入校验 |
| src-tauri/src/tone.rs | 从原始 RGB 曲线生成 3 × 256 LUT |
| src-tauri/src/native.rs | Win32 显示路径、Gamma、DDC/CI 与句柄生命周期 |
| src-tauri/src/engine.rs | 单工作线程、顺序队列、预览合并、草稿、应用与恢复 |
| src-tauri/src/storage.rs | 配置原子替换、恢复记录、日志 |
| src-tauri/src/shortcuts.rs | 全局注册、冲突回滚、按键动作 |
| src-tauri/src/lib.rs | IPC、窗口、托盘、单实例与退出流程 |

## 控制与恢复约定

- 默认效果关闭。点击开启、选择另一预设或触发预设快捷键时才应用。应用启动时自动应用为用户可选项，默认关闭。
- 不实现开机自启；“启动后进入托盘”仅指用户手动启动应用时隐藏窗口。
- 关闭窗口保留后台进程、效果和快捷键。正常退出前恢复原始 Gamma 与会话内管理过的硬件参数。
- Gamma 中性值保留读取到的原始曲线，不用线性曲线替换既有校准。非中性值基于该原始曲线计算，并检查写后读回结果。
- 硬件控制只有在预设选择该项后才应用。滑动该项也会将其加入预设；取消选择会恢复会话开始时记录的值。
- UI 值归一化为 0–100，写入时按显示器报告的原生最大值换算，恢复使用原始原生值。
- 首次写入前原子保存恢复记录。准备、持久化或写入任一步失败，停止应用并尝试恢复；无法恢复时保留记录，阻止新会话覆盖它。
- 原始 / 当前对比保留本次会话的基线；关闭效果后重新开启则重新读取基线。
- 显示拓扑或已应用曲线改变时暂停效果。断开显示器后的恢复记录保留到原设备可访问。
- 快捷键录入期间暂停本应用的全局键；完成、取消或失焦后恢复。全局注册使用 MOD_NOREPEAT；F12 禁用。Windows 不能检查游戏内部快捷键冲突。
- 连续预览只合并相邻请求；关闭、显示切换、预设切换、快捷键等保持顺序。前端刷新 / 切换 / 保存会先等待已发出的预览，防止保存到过期值。

原生数据保存在 Tauri app_data_dir（Windows 通常为 `%APPDATA%\app.lumashift.desktop`）：`config.json`、`recovery.json`、`lumashift.log`。窗口设置页可打开目录。恢复完成前不要删除 recovery.json。预设导出只包含已保存的数据，不包含未保存草稿。

## 本次验证

- TypeScript 检查和 Vite 生产构建通过。
- Rust 编译与 12 项单元测试通过；覆盖非法导入、重复快捷键、F12、曲线保持校准及单调性、DDC 能力解析、原子配置替换、恢复记录结构、预览队列不跨越关闭 / 快捷键边界。
- 浏览器检查：预设选择、新建 / 删除临时预设、Gamma 数值修改、跨预设草稿保留、保存及重载、原始 / 当前对比、主题和语言切换、重复快捷键拒绝及组合键录入；最终页面未记录控制台 error / warn。
- 原生只读检测：P275MS PLUS，SDR，Gamma 可读；亮度 60、对比度 55、R/G/B 增益 50/47/49。设备能力串未声明整体饱和度 0x8A 和锐度 0x87，因此显示为未提供。数值是检测时的读数，不是应用默认值。
- 已生成 Windows x64 release 可执行文件，并运行该发布副本的 `--diagnose` 模式通过只读冒烟检查；原始结果见 [hardware-readonly-2026-09-26.json](hardware-readonly-2026-09-26.json)。没有在本次自动验证中改变真实 Gamma 或任何显示器参数。
- 发布副本为 10,957,824 字节；SHA-256：`B89CB95969AC6CBA3DF8716CBAFE564B3F782B836114D9B6444F8F996E8D10AB`。

## 交互式实机验收

以下项目尚未进行真实写入验证，不能用浏览器模拟结果替代：

1. 打开原生程序，确认设备及能力读取正确；轻微调 Gamma，检查桌面、游戏内的实际效果与读回。
2. 轻微调整一个硬件项，检查原始 / 当前切换、关闭效果与退出后的恢复；观察硬件固件是否顺带切换图像模式。
3. 录入 F 键及组合键，验证原生全局注册、按住不重复、关闭到托盘后继续工作、重新打开及单实例行为。
4. 手动退出、异常结束后重启恢复、睡眠唤醒、热插拔和多屏切换。
5. 不支持 DDC、显示器 OSD 关闭 DDC/CI、系统占用快捷键、Gamma 被其他软件覆盖时的真实反馈。

驱动可能拒绝某些极端组合、覆写 Gamma 或报告无法反映物理画面的读回值；DDC 实现也因显示器而异。HDR / Advanced Color 和镜像输出不启用 Gamma。首版不保证独占全屏、所有扩展坞、远程桌面或所有显示器固件的行为。

## Gamma 数值的含义

显示器 OSD Gamma 改变显示器自身的灰阶响应；LumaShift 通过 Windows 配置显卡输出查找表。两者串联生效，软件的 1.00 只代表不额外改变原始曲线，不等于 OSD Gamma 1.0。保存预设时应保持显示器 Gamma 档位稳定。我们不会读取或修改 OSD 中的 Gamma 档位。

参考：[Microsoft 显卡输出 Gamma 说明](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/using-gamma-correction)、[SetDeviceGammaRamp 限制](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-setdevicegammaramp)。
