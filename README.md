# gamelike-plugin-manage — 插件管理

设置 → **插件管理**：管理所有插件（DSH 原装插件 + 用户自装插件）。
一个插件包，双面工作：host 读 loader 树与 profile 持久层，client 在 `settings.section` 提供管理界面。

## 第一级菜单 / 核心模块

- **管理插件（M1，已实现）**：列出 loader 树全部插件（官方 / 用户 / 临时注入），
  原生插件只允许禁用/启用（不可卸载），用户插件允许禁用/启用/卸载。
  所有操作**只写 profile 配置**，当前进程不动，**重启 DSH 后生效**；
  原生插件的禁用写进 `cordis.patch.yml`，因此重启后**不恢复**。
- **插件安装（M2，已实现）**：三种方式任选，统一落点 profile bundles + 立即装配（重启仍在）：
  1. 本地目录路径（Windows / WSL 路径均可，未构建会自动构建）；
  2. 拖拽 `.tgz` / `.tar.gz` 到页面区域，松手即自动上传安装；
  3. GitHub 地址 / npm 包名或安装指令共用一个输入框，自动识别（clone 或 npm pack）。
- **开发插件（M3，空壳）**：暂未开放。
- **插件包（M4，空壳）**：暂未开放。

M1 界面支持：按 id / 包名搜索；两组折叠（**原生** / **用户**，临时注入归入用户组）。

## M1 的持久化机制

操作分两步：

1. **点击操作（重启前）**：只写 `${DSH_HOME}/plugin-manage.pending.json` 待重启队列，**不碰任何 profile 配置**，当前进程完全不动；
2. **重启后**：本插件 apply 时延迟 2 秒执行队列，把操作真正写入 `cordis.patch.yml` / `package.json`，DSH 的 include 随即热应用。

因此「取消卸载」= 删除队列记录即可，配置从未被改动；重启后队列与运行状态一致时自动清空。

| 操作 | 重启后写入位置 | 结果 |
| --- | --- | --- |
| 禁用原生插件 | `~/.dsh/profiles/<profile>/cordis.patch.yml` → `- id: X, disabled: true` | 保持禁用（patch 层优先于官方配置） |
| 启用原生插件 | 同上 → `disabled: false` | 恢复启用 |
| 禁用用户插件 | 同上 | 保持禁用 |
| 卸载用户 bundle 插件 | `profile package.json`：从 `dependencies` + `dsh.profile.bundles` 移除；patch 写 `disabled: true` 防加回 | 不再装配 |
| 卸载用户 patch-insert 插件 | 从 `cordis.patch.yml` 的 `insert` 子列表删除该行 | 不再装配 |
| 临时注入插件 | 只读展示（重启即消失，无法持久操作） | 自动消失 |

待重启变更记录在 `${DSH_HOME}/plugin-manage.pending.json`，重启后与运行状态一致时自动清除。

## GUI API（webServer prefix 路由）

| 方法 | 路径 | 请求体 | 说明 |
| --- | --- | --- | --- |
| GET | `/plugin-manage/api/list` | — | 全部插件 + 来源 + 运行/期望状态 + 待重启列表 |
| POST | `/plugin-manage/api/disable` | `{ id }` | 持久禁用（重启生效） |
| POST | `/plugin-manage/api/enable` | `{ id }` | 持久启用（重启生效） |
| POST | `/plugin-manage/api/uninstall` | `{ id }` | 持久卸载用户插件（重启生效；原生/注入型拒绝） |
| POST | `/plugin-manage/api/cancel-uninstall` | `{ id }` | 取消待重启卸载 |
| POST | `/plugin-manage/api/install-local` | `{ path }` | 本地目录安装（立即装配 + 持久化） |
| POST | `/plugin-manage/api/install-tgz` | 二进制 body + `x-file-name` 头 | 上传 tgz 安装 |
| POST | `/plugin-manage/api/install-source` | `{ source }` | GitHub 地址或 npm 包名/指令安装 |

## 来源判定

- 包名以 `@deepseek-ai/`、`node:`、`cordis:` 开头 → 原生；
- 登记在 profile `dsh.profile.bundles` 或 patch `insert` 里 → 用户；
- 其余（裸包名 / 绝对路径 / `@dsh-external` 未登记）→ 临时注入，只读。

## 构建与装配（本插件自己也持久装配，重启不消失）

```bash
npm install          # typescript + yaml
npm run build        # link 依赖 + tsc 编译 host → lib/
npm run build:client # 复制手写 client bundle → lib/client.js
```

运行时装配（免重启）：把包目录交给 DSH 的 `dev_install_package`，它会写入
profile `package.json` 的 `dependencies` + `dsh.profile.bundles` 并立即加载；
此后每次重启由 bundle 装配自动回来（包内 `dsh.bundle.patch → ./cordis.patch.yml`）。
