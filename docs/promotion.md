# 推广文案

## 中文：社区发帖版

**DSH 插件管理器正式公开：管理你的 DSH 插件，终于不用手改配置了。**

入口就在 **设置 → 插件管理**：

- **管理插件**：查看 loader 树里的全部插件，禁用、启用、卸载用户插件；改动先进入待重启队列，一键重启 DSH 后生效，卸载可反悔。
- **插件安装**：本地目录、拖拽 `.tgz`、GitHub 地址、npm 指令四种方式都能装；带任务队列和进度，失败还能一键交给 AI 排错。
- **插件包**：把一组插件打包成 `.tgz`，换机器拖进去就能恢复插件和分组，适合迁移你的 DSH 配置。
- **Agent 预设清理**：禁用/卸载插件时，会按归属标记清理它带来的本地 Agent 预设，不再残留“角色会话”这类幽灵预设。
- **自重启**：内置 DSH 重启按钮，WSL / Linux / Windows 都做了兼容处理。

技术栈：TypeScript + Cordis loader，MIT 协议，欢迎 PR / Issue / Discussion。

🔗 https://github.com/p83765295-sys/gamelike-plugin-manage
📦 Release：https://github.com/p83765295-sys/gamelike-plugin-manage/releases/tag/v0.1.0

## 中文：短版（适合聊天群/动态）

DSH 插件管理器 `gamelike-plugin-manage`：
设置 → 插件管理，安装/卸载/禁用/更新插件，导出插件包，清理插件自带 Agent 预设，还能一键重启 DSH。
MIT 开源，欢迎体验和贡献。
https://github.com/p83765295-sys/gamelike-plugin-manage

## English

`gamelike-plugin-manage` — a plugin manager for DeepSeek Harness (DSH).

Open **Settings → Plugin Manager** to:

- inspect, disable, enable, and uninstall plugins
- install from local directories, `.tgz` archives, GitHub URLs, or npm
- export groups of plugins as portable plugin packs
- clean up owned local Agent presets when plugins are disabled or uninstalled
- restart DSH from the UI

MIT licensed. PRs, issues, and discussions are welcome.

🔗 https://github.com/p83765295-sys/gamelike-plugin-manage
📦 https://github.com/p83765295-sys/gamelike-plugin-manage/releases/tag/v0.1.0

## 关键词 / Hashtags

`DSH` `DeepSeek Harness` `plugin-manager` `plugin-pack` `agent-preset` `插件管理` `插件包` `开源` `TypeScript`
