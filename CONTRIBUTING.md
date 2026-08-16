# 参与贡献

感谢你考虑为 gamelike-plugin-manage 做贡献。这个插件在 DSH 的 **设置 → 插件管理** 中提供插件树管理、插件安装、插件包导出与 Agent 预设清理能力。

## 可以做什么

- 报 bug：把现象、复现步骤、环境与日志写清楚。
- 提功能：先说明使用场景与预期行为，再讨论实现。
- 改代码：修 bug、补文档、改进 UI/UX、加测试。
- 翻译：补齐 zh/en 双语文案。
- 测试反馈：在不同平台（Windows / WSL / Linux / macOS）验证安装、重启、导入导出。

## 本地开发

```bash
git clone git@github.com:p83765295-sys/gamelike-plugin-manage.git
cd gamelike-plugin-manage
npm install --include=dev
npm run typecheck
npm run build
npm run build:client
```

构建脚本会通过 `DSH_CHECKOUT` 或全局 npm 安装位置探测 DSH 依赖。

改完代码后，在 DSH 中热重载验证：

```bash
dev_reload_package gamelike-plugin-manage
```

## 必须遵守的约定

- 修改 `src/`，不要直接改 `lib/client.js`（会被构建覆盖，也不进 git）。
- UI 文案必须 zh/en 双写，全部走 locale 字典。
- 视觉只使用 `--dsw-alias-*` 语义令牌，不硬编码颜色。
- 宿主没有全局 `box-sizing: border-box`；`width: 100% + padding` 必须显式声明。
- 分组身份是真实 bundle 包名，不是运行 entry 名（涉及 `resolveBundleName` / `readBundleInsertMap`）。
- 预设清理只允许两条归属路径：`.plugin-manage-owner.json` 和第三方 `*.owner.json`；不要通过解析 `agent.cordis.yml` 反推归属。
- 图标功能已按用户要求移除，不要恢复。

## Pull Request 流程

1. 从最新的 `main` 拉新分支。
2. 一个 PR 只做一件事；标题写清楚，例如 `修复整组启停部分生效：...`。
3. 自己先跑 `npm run typecheck`、`npm run build`、`npm run build:client`。
4. 涉及 UI 的改动附截图；涉及安装/卸载/重启/预设删除的改动必须说明安全影响。
5. 提交 PR 时按模板填写。
6. 合并采用 Squash and merge。

## 安全基线

- 第三方仓库安装不执行其 `install.ps1` / `install.sh` / git hooks。
- 依赖安装使用 `npm install --ignore-scripts`。
- 默认拒绝构建脚本，只有用户显式勾选才允许。
- 插件包导入必须校验 sha256 与路径越界。
- 新增任何“自动执行外部代码”的路径都需要在 PR 描述中明确风险。

## 沟通

- 简单问题用 GitHub Discussions。
- Bug 用 Issue 模板报告。
- 安全漏洞不要公开提，发邮件到 `p83765295@gmail.com`。
