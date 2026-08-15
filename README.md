# gamelike-plugin-manage — 插件管理（交接文档）

> 本 README 是给下一个 AI 会话/开发者的**完整交接文档**：读它 + `src/` 代码注释 +
> `git log` 即可继续开发，无需重新调查环境。

## 1. 项目定位

DSH 插件管理 UI，入口：**设置 → 插件管理**（`settings.section`，id `gamelike-plugin-manage`）。
单包双面：host 是 TS（`src/*.ts` → `lib`），client 是手写零构建 React bundle
（`src/client/bundle.js` → `lib/client.js`）。包名/目录：

```
/mnt/c/Users/Administrator/Documents/dsharness/gamelike-plugin-manage
```

已持久装配在 `web` profile（`dependencies` link + `dsh.profile.bundles`），重启后自动回来。
当前运行 entry id 可能是 `plugin-manage` 或 `include:plugin-manage`（include 展开形态，正常）。

## 2. 四大模块状态

| 模块 | 状态 | 功能 |
|---|---|---|
| M1 管理插件 | ✅ 完成 | 全部 loader 行列表；原生/用户两组折叠 + 搜索；hash id 显示友好短名 |
| M2 插件安装 | ✅ 完成 | 本地目录 / tgz 拖拽上传 / GitHub / npm，安装队列 + 进度条 |
| M3 开发插件 | ⬜ 空壳 | 占位 |
| M4 插件包 | ⬜ 空壳 | 占位 |

### M1 规则（用户拍板过的）

- 来源分类：`@deepseek-ai/*`、`node:*`、`cordis:*` → **原生**；登记在 profile bundles
  或 patch insert → **用户**；其余 → **临时注入**（只读）。
- 原生插件：允许禁用/启用，**不允许卸载**。用户插件：禁用/启用/卸载。
- 操作只写 `${DSH_HOME}/plugin-manage.pending.json` 待重启队列，**当前进程不动**；
  重启后本插件 apply 时延迟 2s 执行队列，把操作写入
  `profiles/web/cordis.patch.yml` / `package.json`，由 include 热应用。
  → 官方禁用重启不恢复；卸载重启前可取消（取消=删队列记录，配置从未被改）。
- ⚠️ 重要事实：直接写 patch/package.json 会被 DSH 的 include **立即热应用**
  （曾导致插件管理自己 API 消失），所以 M1 才设计成 pending-only。

### M2 规则（用户拍板过的）

- 三种来源：本地目录路径（Windows/WSL 均可）、拖拽 `.tgz` 自动上传、GitHub 地址
  与 npm 指令合一输入框（自动识别；`github.com/...` 自动补 https）。
- 安装语义：**立即装配 + 持久化**（写 profile dependencies + bundles + junction +
  loader.create），重启仍在。
- **安装队列**：`src/tasks.ts`。提交立即返回任务号；准备阶段（clone/pack/解压/
  依赖/构建）最多 3 路并行；激活阶段（写配置 + loader.create）串行。
  任务带步骤日志 + 百分比进度；内存态，插件热重载/重启后历史清空。
- **安全策略**（用户确认执行）：
  1. 永不执行仓库自带的 install.ps1 / install.sh / git hooks；
  2. 套装识别只认声明式文件（`package.json` 或 `preset.yml + agent.cordis.yml`）；
  3. 依赖安装用 `npm install --ignore-scripts`（零生命周期脚本）；
  4. 构建脚本默认**拒绝执行**，UI 勾选「允许执行构建脚本」后才跑 npm rebuild / build；
  5. clone `--depth 1`，失败自动清理 clone 残留；已 clone 目录重试时复用。
- **bundle-only 识别**：入口不导出 `apply` 但 `dsh.bundle.patch` 存在（如 archify）
  → 只写 bundles + junction，不 loader.create，提示重启后由 include 装配。

## 3. 源码地图

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 入口；`inject=['loader','webServer','timer']`（webServer 时序坑见 §6）；重启后 2s 调 applyPending |
| `src/config.ts` | Config：`profile`(默认 web)、`home`；`pluginsDir` = `dirname(home)/dsh-plugins` |
| `src/types.ts` | 列表/来源/pending 类型 |
| `src/profile.ts` | 持久层读写：package.json bundles/deps、cordis.patch.yml YAML 编辑（yaml 库保留注释）、pending.json |
| `src/service.ts` | 列表/禁用/启用/卸载/取消卸载/applyPending + M2 enqueue（prepare 并行、activate 串行） |
| `src/installer.ts` | M2 两阶段：prepareLocal/prepareTgz/prepareSource + activatePrepared；安全策略；node-pty 宿主复用；bundle-only 检测 |
| `src/tasks.ts` | InstallQueue：3 并行、finalize 串行链、步骤、进度、历史 40 条 |
| `src/gateway.ts` | webServer prefix 路由 `/plugin-manage/api`；tgz 上传体上限 128MiB |
| `src/client/bundle.js` | 手写零构建 client：四个 Tab；M1 列表；M2 表单 + 紧凑实时信息流（只显示进行中 + 完成8s/失败30s） |

## 4. HTTP API（`/plugin-manage/api`）

| 方法/路径 | 说明 |
|---|---|
| GET `/list` | M1 完整状态 |
| POST `/disable` `/enable` `/uninstall` `/cancel-uninstall` | body `{id}`；写 pending 队列 |
| GET `/install-tasks` | 安装队列快照（含步骤与进度） |
| POST `/install-local` | body `{path, allowBuild}` → 立即返回 `{taskId,message}` |
| POST `/install-tgz` | 二进制 body + `x-file-name` / `x-allow-build` 头 |
| POST `/install-source` | body `{source, allowBuild}`，GitHub 或 npm |

## 5. 构建 / 热重载 / 测试

```bash
cd /mnt/c/Users/Administrator/Documents/dsharness/gamelike-plugin-manage
npm install --include=dev          # typescript + yaml + tar
bash scripts/build.sh              # 探测 /usr/local/lib/node_modules/@deepseek-ai/dsh，link 依赖 + tsc
npm run build:client               # 复制 src/client/bundle.js → lib/client.js
```

- 热重载：DSH 环境里 `dev_reload_package gamelike-plugin-manage`（host+client 免重启）。
- 持久装配：`dev_install_package /mnt/c/.../gamelike-plugin-manage`（已装，幂等）。
- 本机 DSH web 端口：`http://127.0.0.1:3081`。
- 测试插件源：`dsharness/pm-test-toolkit`（toolkit 骨架）、`pm-test-uipanel`（ui-panel 骨架），
  均已构建过；`/tmp/pm-demo-plugin`、`/tmp/pm-demo-tgz`、`/tmp/pm-demo-npm` 是最小样例。
- 队列语义单测：`node /tmp/test-queue.mjs`（4 任务、3 并行、激活串行）。

## 6. 已踩过的坑（不要重蹈）

1. **webServer 时序**：必须 `inject: ['webServer']` 硬依赖；否则重启装配时 API 未注册，
   页面请求落到 SPA HTML → `Unexpected token '<'`。
2. **`.dsh` 路径解析**：DSH loader 对 `~/.dsh/...` 下插件的 node_modules 依赖解析异常
   （找不到 ws）。M2 解包/克隆目录必须在 `.dsh` 之外 → `dirname(DSH_HOME)/dsh-plugins`。
3. **写 patch/package.json 会被 include 立即热应用**：M1 因此用 pending-only 延迟写。
4. **node-pty**：WSL 下 node-gyp 编译失败；M2 复用宿主 `/usr/local/lib/node_modules/
   @deepseek-ai/dsh/node_modules/node-pty`（同版本 symlink，否则复制二进制）。
5. **tsdown 缺 unrun**：unrun 是 tsdown optional peer，npm 不装 → 检测 devDeps.tsdown 后补装。
6. **tgz 跨盘 rename**：/tmp → /root 用 `cpSync`，不能 `renameSync`。
7. **npm install 环境**：DSH 进程 NODE_ENV=production 会导致 devDeps 不装；
   所有子进程命令强制 `env.NODE_ENV=development` + `--include=dev`。
8. **loader.create 入口**：必须指向 `lib/index.js` 文件，不能传目录（Directory import 报错）。
9. **archify 类 Skill-only bundle**：入口无 `apply`，不能 loader.create，走 bundle-only 分支。
10. **hash entry id**：loader 自动生成的短 hash（如 `85cb9046`）只是临时 id，UI 用包名
    派生友好短名显示，真实 id 放第二行小字。

## 7. 用户已确认的产品决策

- 名字：插件管理（原"插件协调器"已废弃）。
- M1 操作重启后生效、原生禁用重启不恢复、卸载可取消。
- M2 装成用户插件、立即生效并持久化；安全策略如上。
- UI：信息流要紧凑、只显示进行中与刚结束、不要历史堆叠；进度条 3px + 百分比。
- vision-router 是用户**故意卸载**的，不要恢复。
- dsh-routing-suite 是"套装仓库"（injector 插件 + router-standard preset），非插件包；
  已通过声明式识别支持，但不执行其自带 install.ps1。

## 8. 待办（下一会话候选）

- M3 开发插件、M4 插件包（用户会从需求角度逐条给）。
- 安装队列目前内存态：跨插件热重载历史会丢（可考虑落盘）。
- GitHub 套装多插件目录的进度目前合并为单任务进度。
- 可考虑把 M1 的 preset（agent preset）只读分组加回来。

## 9. Git 里程碑

`v0.1` M1 完成 → `v0.2` M2 完成 → 之后提交：安全策略、安装队列、进度条、bundle-only 修复。
