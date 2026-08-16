# gamelike-plugin-manage

DSH 插件管理器：入口位于 **设置 → 插件管理**。提供插件树管理、插件安装、插件分组与插件包导出。

## 功能

| 模块 | 说明 |
|---|---|
| 管理插件 | 查看运行中的全部插件；原生 / 用户 / 临时注入分类；禁用、启用、卸载（卸载仅用户插件，重启后生效） |
| 插件安装 | 本地目录、拖拽 `.tgz`、GitHub 地址或 npm 指令；安装队列 + 进度；失败任务可「交给 AI 配置」 |
| 开发插件 | 占位，后续开放 |
| 插件包 | 将已安装的用户插件（无论启用/禁用）加入分组，导出为 `.tgz` 插件包；安装插件包后自动恢复分组 |

### 分组

- 分组是引用集合（tag）：一个插件可以同时属于多个分组。
- 分组会显示在「管理插件」列表，可一键「整组启用 / 整组禁用」。
- 分组与期望状态（`enabled` / `disabled` / `as-is`）会随插件包导出，并在安装时恢复。
- 同一插件出现在多个选中分组/多个插件包时，导出端只内嵌一份，导入端按身份去重。

## 安装到 DSH

任选一种：

1. **插件安装 Tab → 拖拽 `.tgz`**：适合安装已导出的插件包。
2. **GitHub 地址**：输入 `https://github.com/<owner>/<repo>`（自动 clone + 构建）。
3. **npm 指令**：输入 `npm install <pkg>` 或包名（自动 `npm pack` 后安装）。
4. **本地目录**：输入项目目录（含 `package.json` 与 `lib/`；若缺少 `lib/` 且勾选「允许执行构建脚本」会尝试构建）。

## 插件包格式（dsh-plugin-pack@2）

导出的 `.tgz` 解包结构：

```
<包名>.tgz
├── package.json      # 声明 dsh.pack.format = dsh-plugin-pack@2
├── manifest.yml      # 分组、期望状态、插件清单（name / path / version / sha256）
└── plugins/<包名>/   # 插件目录本体（不含 node_modules / .git）
```

导入时：

1. 逐成员校验 `sha256`（内容被篡改直接拒绝）；
2. 吸收进内容寻址 PluginStore（`~/.dsh/plugin-store/<name>/<version>-<hash>`），同内容交集复用同一实体；
3. 构建包级装配计划（InstallPlan），逐成员裁决；
4. 通过预检的成员写入 profile bundles（立即装配并持久化），任一成员装配失败则本包整体回滚；
5. 分组恢复到「管理插件」；
6. 按分组期望状态为运行中的插件写入待重启状态（重启后生效）。

兼容性：仍可导入 `dsh-plugin-pack@1` 旧包（无 version/sha256 声明时不校验内容，按包名判断交集）。

### 交集裁决规则

| 交集类型 | 裁决 |
|---|---|
| 同 name + 同 version + 同 sha256（安全交集） | 跳过，复用已装实体 |
| 同 name + 同 version + 不同 sha256（内容冲突） | 拒绝安装该成员，不静默覆盖 |
| 同 name + 不同 version（版本冲突） | 拒绝安装该成员，提示先卸载旧版或使用更新 |
| entry id / bundle patch id 被其它插件占用 | 拒绝安装该成员 |
| patch 顶层存在 disabled 覆盖（旧卸载意图） | 显式重新安装时清除覆盖，按包内版本装配 |
| 包内同 name 重复出现 | 只吸收一次（导出端已 seen 去重） |

## 开发

要求：Node.js 20+、npm；并已安装 DSH（构建时通过 `DSH_CHECKOUT` 或全局 npm 安装位置探测依赖）。

```bash
npm install --include=dev
npm run build            # 链接 DSH 依赖 + 编译 src → lib
npm run build:client     # 复制浏览器端 bundle → lib/client.js
npm run typecheck        # 类型检查
```

在 DSH 中热重载：

```bash
dev_reload_package gamelike-plugin-manage
```

持久装配：

```bash
dev_install_package <repo-dir>
```

## HTTP API

所有接口位于 `/plugin-manage/api`：

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

## 安全策略

- 安装第三方仓库时，不执行其自带的 `install.ps1` / `install.sh` / git hooks。
- 依赖安装使用 `npm install --ignore-scripts`（不执行生命周期脚本）。
- 默认拒绝执行构建脚本；仅当用户勾选「允许执行构建脚本」后才运行 `npm rebuild` / `npm run build`。
- `git clone` 使用 `--depth 1`，失败自动清理残留。

## 插件开发兼容性

- Windows / macOS / Linux / WSL 均可构建与运行（构建脚本为跨平台 Node 脚本）。
- Windows 原生环境下，安装/更新会使用 `npm.cmd` / `npx.cmd` 等可执行扩展名。
- 仅当插件自带 `scripts/build.sh` 且无 `npm run build` 时，原生 Windows 无法自动构建，需要先在本地构建好再安装。

## License

BSD-3-Clause
