# GitHub Release 工作流

工作流：`.github/workflows/release.yml`。推送 `v*` 或数字开头的 tag 时触发；验证器只接受 `0.1.0`、`v0.1.0`、`v0.1.0-rc.1` 这类版本标签。

## 流程

1. 检出 tag 对应代码，校验 tag 与 package.json、package-lock.json、Cargo.toml、Cargo.lock、tauri.conf.json 的应用版本一致。只校验，不改文件。
2. 在 Windows Server 2022 x64 runner 使用 Node.js 24 和本地已验证过的 Rust 1.92.0 MSVC 工具链安装依赖，执行版本校验测试与 Rust 测试。
3. 调用现有 `npm.cmd run desktop:build`，包含前端类型检查、Vite 构建及 Tauri `--no-bundle` 发布构建。
4. 将独立 EXE 作为 Actions artifact 传递给发布 job，保留 7 天。仅发布 job 有 contents:write 权限。
5. 用 GitHub CLI 创建 Release、生成发行说明并附加 `LumaShift-<版本>-windows-x64.exe` 和 MIT `LICENSE` 文件。带预发布后缀的版本标记为 prerelease。

EXE 仍依赖目标系统的 WebView2 Runtime，不是安装器。本流程不执行原生应用，不读取或修改显示器。

## 使用与重试

- 先提交工作流及所需代码，再创建并推送 tag。当前用户确认的版本为 0.1.0。
- 修改版本时由维护者明确决定并同步上述文件；工作流不会生成 tag、升级版本或回写提交。
- 使用仓库自带 GITHUB_TOKEN，不需要个人访问令牌；仓库策略需允许发布 job 的 contents:write。
- 构建或测试失败时不会执行发布 job，可在 Actions 中重跑失败任务。
- 已存在同名 Release 时，创建步骤会报错，不自动覆盖已发布的 EXE。若首次上传中断留下草稿，应检查草稿和资产后再处理。
- 同一 tag 的运行串行执行，不取消正在执行的发布任务。
- 如果 tag 已推送但没有运行记录，可在 Actions → Release Windows → Run workflow 中选择 main 并输入已有 tag，或执行 `gh workflow run release.yml --ref main -f tag=v0.1.0`。工作流从 main 加载，但源码明确检出 refs/tags/<tag>，版本检查及 Release 均使用该 tag，不移动或重建标签。

## 验证范围

本地验证版本一致性检查、异常 tag / 不一致版本拒绝、预发布识别和 YAML 结构；当前版本的 Windows release 构建已通过。远端为 `Adamska1008/LumaShift`，云端 runner 和发布权限由首次 tag 工作流运行验证。

参考：[GitHub CLI release create](https://cli.github.com/manual/gh_release_create)、[Windows 2022 runner 环境](https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md)。
