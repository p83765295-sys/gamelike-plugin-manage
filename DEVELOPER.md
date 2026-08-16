# DEVELOPER.md — gamelike-plugin-manage 开发文档

面向维护者与贡献者。面向用户的安装/使用说明见 [README.md](./README.md)。

## 构建与调试

要求 Node.js 20+、npm，并已安装 DSH（构建时通过 `DSH_CHECKOUT` 或全局 npm 安装位置探测依赖）。

```bash
npm install --include=dev
npm run typecheck        # 仅类型检查
npm run build            # 链接 DSH 依赖 + 编译 src → lib
npm run build:client     # 复制浏览器端 bundle → lib/client.js
```

DSH 内热重载（当前进程生效，host + client）：

```bash
dev_reload_package gamelike-plugin-manage
```

持久装配（重启后仍在）：

```bash
dev_install_package <repo-dir>
```

注意：`lib/` 在 `.gitignore` 中，修改 `src/` 后必须重新构建；**不要在 `lib/client.js` 上直接改 UI**（会被下一次构建覆盖，也进不了 git）。

## 架构

```
src/
├── index.ts        host 入口：inject loader/webServer/timer，2 秒后应用 pending
├── config.ts       Config schema + 持久层路径解析
├── gateway.ts      HTTP API（/plugin-manage/api/*）
├── service.ts      PluginManageService：运行树投影 + 变更编排 + 安装队列
├── tasks.ts        安装队列：准备阶段并行(3) / 激活阶段串行
├── installer.ts    安装/更新/导出；两阶段 prepare/activate；InstallPlan
├── store.ts        PluginStore：内容寻址吸收 (name, version, sha256)
├── profile.ts      profile 持久层：package.json / cordis.patch.yml / pending
├── groups.ts       分组持久层（多归属 tag）
├── types.ts        共享类型
└── client/
    └── bundle.js   浏览器半：设置页 section + 全部 UI（locale + slots）
```

## 核心设计

### 1. M1 的 pending 两阶段

管理操作（禁用/启用/卸载）**不立即写 profile**，只写 `~/.dsh/plugin-manage.pending.json`；重启后 `applyPending()` 才真正写 `cordis.patch.yml` / `package.json`。好处：重启前可随时取消，配置从未被动过。

- 只对**真正需要变更**的插件写 pending：已处于目标状态的插件直接返回「无需重启」，避免产生会被 `prunePending` 立即清掉的无效记录。
- 「重启 DSH」按钮只在存在真实 pending 时出现。

### 2. 插件包 = 引用集合，导入 = 约束求解

- 身份 = `(name, version, sha256)`，不是单纯的包名。
- 导出 `.tgz` 是容器（内嵌插件副本，离线可装）；导入时先吸收进 PluginStore 成为实体，再走 `buildInstallPlan` 交集裁决。
- 导出 UI 支持折叠选择要导出的现有分组（默认全选，至少保留一个）。
- 裁决表见 README「交集裁决规则」。

### 3. 包级事务

`activatePrepared` 对 pack 先构建权威 InstallPlan（基于真实 loader 树），只激活 `install` 项；任一成员装配失败时 `rollbackActivated` 按逆序卸载本轮已装配的全部成员 + 清 bundles/junction。

### 4. 分组身份 = bundle 包名

- 分组存的是**真实 bundle 包名**，不是运行 entry 名。
- 例：`@tt-a1i/archify-dsh` 的 bundle patch 插入 `@deepseek-ai/dsh-skill-filesystem`；分组应存前者。
- `readBundleInsertMap()` 同时映射 patch 行的 `id` 和 `name` 到 bundle 包名；`service.resolveBundleName()` 负责运行名反查。
- 旧分组数据（存运行名）在 `upsertGroup` 时自动迁移；`exportPack` 也会反查，因此旧数据可正常导出。

### 5. 多归属与 desired 冲突

- 一个插件可属于多个分组（tag）。
- 安装插件包恢复分组时，若同一插件在不同组声明不同 desired，**禁用优先**（安全向）。

### 6. DSH 自重启（src/restart.ts）

- 独立重写实现；行为设计参考 dsh-market（MIT License，Copyright (c) 2026 fkysly and dsh-market contributors）。
- 精确重放启动命令（bin/dsh/源码入口）、detached helper 延迟 1.5s 拉起新进程、Windows 用 PowerShell `-WindowStyle Hidden` 包装。
- `config.allowRestart`（默认 true）为 false 时禁用，supervisor 托管部署应显式关闭。
- HTTP 仅接受 loopback 直连 + Origin/Host 一致 + 无转发头；安装任务运行中拒绝。

## HTTP API

所有接口位于 `/plugin-manage/api`。

| 方法/路径 | 说明 |
|---|---|
| `GET /list` | 运行树、待重启队列、分组完整快照 |
| `POST /disable` `/enable` `/uninstall` `/cancel-uninstall` | 写待重启队列（`{id}`） |
| `POST /update` | 更新用户插件（`{id}`） |
| `POST /delegate-ai` | 失败任务交给 AI 配置（`{taskId}`） |
| `GET /install-tasks` | 安装/更新队列快照 |
| `POST /install-local` | 本地目录安装 |
| `POST /install-tgz` | `.tgz` 上传安装 |
| `POST /install-source` | GitHub / npm 安装 |
| `GET /groups` | 分组列表 |
| `POST /groups/upsert` `POST /groups/delete` `POST /groups/apply` | 分组管理 |
| `GET /export-pack` | 导出插件包（浏览器下载） |
| `POST /restart` | 调度 DSH 自重启（仅 loopback 同源；安装任务运行中拒绝） |

## 客户端（browser half）

- 注册进官方 `settings.section` 槽位，`locale: 'plugin-manage'` 注入 `t()`。
- 所有 UI 文案在 `zh` / `en` 字典（`src/client/bundle.js` 顶部），组件不硬编码文案。
- 视觉只使用 `--dsw-alias-*` 语义令牌，不硬编码 hex；卡片/按钮/间距对齐官方 `dsh-client-ui-settings-plugins` 规范。
- 新增 UI 文案时必须同时补 zh/en 两套键，否则英文环境显示 key。

## 已知约定与坑

1. **宿主没有全局 `box-sizing: border-box`**：任何 `width:100% + padding` 的组件都要显式加 `box-sizing:border-box`（官方组件也是各自声明）。
2. **滚动容器**：固定高度列表 rebind `--dsh-scrollbar-thumb{,-hover}` 到 l2 token，并考虑 `scrollbar-gutter:stable`。
3. **bundle patch 的 entry 名 ≠ bundle 包名**：涉及分组、导出、整组操作时都必须经 `resolveBundleName` / `readBundleInsertMap`。
4. **`loader.create` 失败可能残留 entry**：回滚时要按请求的 id 尝试 `loader.remove`，再清 junction 与 bundles。
5. **Store 实体是共享的**：`absorbPlugin` 全同步原子；构建产物（node_modules 等）不参与 sha256。
6. **旧插件包兼容**：`dsh-plugin-pack@1` 无 version/sha256，导入时不校验内容、按包名判断交集并提示警告。

## 安全策略（实现于 installer）

- 第三方仓库安装不执行其 `install.ps1` / `install.sh` / git hooks。
- 依赖安装使用 `npm install --ignore-scripts`。
- 默认拒绝构建脚本；用户勾选「允许执行构建脚本」才执行 `npm rebuild` / `npm run build`。
- `git clone --depth 1`，失败自动清理残留。
- 插件包导入校验 sha256；路径越界拒绝。

## 兼容性

- Windows / macOS / Linux / WSL 均可构建与运行（构建脚本为跨平台 Node 脚本）。
- Windows 原生环境下使用 `npm.cmd` / `npx.cmd` 等可执行扩展名。
- 仅当插件只有 `scripts/build.sh` 且无 `npm run build` 时，原生 Windows 无法自动构建，需本地先构建。

## 开发笔记

个人临时实验/草稿放在 `DEV-NOTES.md`（已在 `.gitignore`，不进入版本库）。
