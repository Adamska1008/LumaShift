# DDC/CI 恢复失败修复（0.1.1）

## 现场证据

用户截图显示恢复待处理和 `redGain: DDC/CI read failed`。只读查看应用日志发现亮度、对比度、红色增益均出现过读取失败；恢复记录保留了 Gamma、对比度原始值 55、红色增益原始值 50。无法仅凭日志确定是通信暂时失败、显示器模式限制、驱动还是连接问题。

原实现没有通信重试或命令间隔，写入后立即校验；恢复时即使读到原值仍重新写入；部分成功没有保存进度；手动恢复沿用旧物理句柄。恢复失败时部分调用路径还可能保留过期的“已应用”缓存。

## 修复

- 每次 VCP 读写完成后，下一次命令至少间隔 50 ms（保守实现选择，不是声称 Win32 规定的间隔）；读取最多 3 次，失败退避 150 ms。
- 连续型参数写入前读取并验证范围。已是目标值则不写入。写入后允许延迟读回；写入返回失败也先验证实际值，避免丢失应答后重复写入。最多 3 次写入，无法确认成功仍返回错误。
- 错误保留系统错误信息、参数名和重试次数，不把通信失败视为不支持，也不盲写。
- 恢复按项核实；部分失败时原子保存尚未恢复的项目。再次恢复只处理剩余项目；持久化失败时保留完整记录作为保守回退。
- 恢复失败即暂停效果并清空 Gamma/DDC 已应用缓存。恢复待处理时新的预览或快捷键不再顺带触发恢复写入。
- 用户点击恢复时重新枚举显示器，按记录中的稳定 ID 找回原设备，不用当前选择的其他显示器代替。
- 退出时若恢复失败（包括启动后的遗留记录），显示主窗口和错误。
- 提示说明显示器连接、唤醒和 DDC/CI 检查；执行期间禁用恢复按钮以免重复排队。

## 验证边界

新增使用假通信层的回归测试，覆盖偶发失败、永久失败、范围校验、无须写入、丢失写入应答、延迟读回、读回不匹配，以及部分恢复后的记录序列化/重试、断开连接、损坏记录。测试不调用真实显示器写入。

不删除、改写用户当前配置或恢复记录。真实恢复需用户打开新程序后主动执行；重试机制不能保证解决持续的设备拒绝通信。Profile 的显示器控制总开关是另一项功能，此次未加入。

验证结果：Rust 21 项测试通过，TypeScript/Vite 和 Tauri release 构建通过，`git diff --check` 通过。使用新产物 `--diagnose` 做一次真实只读检测，P275MS PLUS 的对比度 55、红色增益 50 均读取成功且与待恢复原值相同；不能由这一次成功断言间歇性通信问题完全消失，Gamma 实际恢复尚待用户操作。完整结果见 [只读检测](hardware-readonly-0.1.1.json)。

产物：`.local/artifacts/LumaShift-0.1.1.exe`；SHA-256：`E4ABD2B96134FDA10AA6C1DBAE7BB8C0C44330756F4E8D761DFFE4AEE7FE85CE`。

## 参考

- [Microsoft GetVCPFeatureAndVCPFeatureReply](https://learn.microsoft.com/en-us/windows/win32/api/lowlevelmonitorconfigurationapi/nf-lowlevelmonitorconfigurationapi-getvcpfeatureandvcpfeaturereply)：读取当前值、范围以及系统错误，接口通常约 40 ms。
- [Microsoft SetVCPFeature](https://learn.microsoft.com/en-us/windows/win32/api/lowlevelmonitorconfigurationapi/nf-lowlevelmonitorconfigurationapi-setvcpfeature)：写入接口通常约 50 ms，具体实现需验证设备兼容性。
