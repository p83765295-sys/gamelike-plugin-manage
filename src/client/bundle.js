// gamelike-plugin-manage browser half：设置页「插件管理」区段（settings.section）。
// UI 对齐官方 dsh-client-ui-* 设计规范：
//   - 只使用 --dsw-alias-* 语义令牌（不硬编码颜色）
//   - 卡片 = 官方 PluginCard 模式：li > button 折叠头 + body + footer，单列列表
//   - 主按钮反色（label-primary 底 / bg-layer 字），ghost 次按钮
//   - 文案全部走 locale 字典（zh/en），组件只调用 t()
//   - 图标使用 @deepseek-ai/dsh-client-ui-primitives
window.__ModuleLoader__.load({
  id: 'gamelike-plugin-manage',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { useState, useCallback, useEffect, useRef } = React
    const { jsx, jsxs } = require('react/jsx-runtime')
    const { IconChevronDownOutline14 } = require('@deepseek-ai/dsh-client-ui-primitives')

    const inject = ['slots', 'locale']
    const NS = 'plugin-manage'
    const API = '/plugin-manage/api'

    const styles = `
.pm-sec{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.pm-manage,.pm-install,.pm-packages{flex-direction:column;gap:12px;display:flex}
.pm-heading{margin:0;font-size:18px;font-weight:600}
.pm-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:1.5}
.pm-tabs{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:flex-end;gap:22px;margin-top:2px;display:flex}
.pm-tab{color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:0;padding:7px 1px 9px;font-size:13px;line-height:20px;position:relative}
.pm-tab:hover,.pm-tab[data-active=true]{color:var(--dsw-alias-label-primary)}
.pm-tab[data-active=true]:after,.pm-tab:focus-visible:after{background:var(--dsw-alias-label-primary);content:"";border-radius:2px 2px 0 0;height:2px;position:absolute;bottom:-1px;left:0;right:0}
.pm-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:2px}
.pm-badges{align-items:center;gap:8px;min-width:0;display:flex;flex-wrap:wrap}
.pm-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.pm-badge.muted{background:0 0;color:var(--dsw-alias-label-tertiary)}
.pm-badge-item{display:inline-flex;align-items:center;gap:4px;max-width:min(240px,100%);min-width:0;box-sizing:border-box}
.pm-badge-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-groups-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pm-group-chip{appearance:none;display:inline-flex;align-items:center;gap:6px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 8px;font:inherit;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.pm-group-chip:hover{color:var(--dsw-alias-label-primary)}
.pm-group-chip.on{border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary)}
.pm-search{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
.pm-search:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.pm-group{margin:0;padding:0}
.pm-group-head-row{display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap}
.pm-group-head{appearance:none;font:inherit;cursor:pointer;border:0;background:0 0;flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px;padding:8px 0;color:var(--dsw-alias-label-primary);text-align:left}
.pm-group-head:hover .pm-group-title{color:var(--dsw-alias-brand-primary)}
.pm-group-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
.pm-caret{flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary)}
.pm-group-title{font-size:13px;font-weight:600;line-height:1.5}
.pm-group-count{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.pm-list{list-style:none;margin:0;padding:0;flex-direction:column;gap:10px;display:flex}
.pm-plugin-grid{list-style:none;margin:0;padding:0;flex-direction:column;gap:10px;display:flex}
.pm-picker,.pm-groups-scroll{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);scrollbar-gutter:stable}
.pm-picker{max-height:360px;overflow-y:auto;padding-right:4px}
.pm-groups-scroll{max-height:360px;overflow-y:auto;padding-right:4px;flex-direction:column;gap:0;display:flex}
.pm-export-box{border-top:1px solid var(--dsw-alias-border-l2);padding-top:4px;display:flex;flex-direction:column;gap:6px}
.pm-export-list{display:flex;flex-direction:column;gap:2px;max-height:180px;overflow-y:auto;padding:0 0 0 22px}
.pm-export-row{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);cursor:pointer}
.pm-export-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-plugin-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.pm-plugin-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.pm-plugin-card.open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.pm-pc-head{appearance:none;box-sizing:border-box;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.pm-pc-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.pm-pc-headtext{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.pm-pc-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-pc-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.pm-pc-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;display:inline-flex}
.pm-pc-chevron.open{transform:rotate(180deg)}
.pm-pc-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:10px 0 14px;display:flex;flex-direction:column;gap:10px}
.pm-pc-meta{display:flex;flex-direction:column;gap:4px;min-width:0}
.pm-pc-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:0 1 auto;min-width:0;max-width:100%}
.pm-pick-head{flex-wrap:wrap;row-gap:6px}
.pm-pick-head .pm-pc-badges{flex:0 0 100%;max-width:100%;justify-content:flex-end}
.pm-pc-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding-top:12px;display:flex;flex-wrap:wrap}
.pm-mod{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.pm-real{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.pm-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.pm-st{white-space:nowrap;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.pm-st.on{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-success-primary)}
.pm-st.failed{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-error-primary)}
.pm-st.off{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary)}
.pm-st.pending{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-primary)}
.pm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:0 0;white-space:nowrap}
.pm-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.pm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pm-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent}
.pm-btn-primary:hover:not(:disabled){color:var(--dsw-alias-bg-layer-3);border-color:transparent;background:var(--dsw-alias-label-primary-dimmed)}
.pm-btn-danger{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error)}
.pm-btn-danger:hover:not(:disabled){color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error);background:var(--dsw-alias-interactive-bg-hover-danger)}
.pm-btn:disabled{opacity:.4;cursor:default}
.pm-msg{margin-top:4px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);white-space:pre-wrap;max-height:180px;overflow:auto;font-size:12px;line-height:1.5}
.pm-msg.err{border-color:var(--dsw-alias-label-error);color:var(--dsw-alias-label-primary)}
.pm-empty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;padding:12px 0;text-align:left}
.pm-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:0}
.pm-placeholder{border-top:1px solid var(--dsw-alias-border-l2);padding-top:16px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.pm-placeholder b{display:block;color:var(--dsw-alias-label-secondary);font-size:15px;font-weight:600;margin-bottom:6px}
.pm-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:8px;min-width:0}
.pm-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.pm-card-desc{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0;line-height:1.5}
.pm-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
.pm-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.pm-inline{display:flex;gap:8px;align-items:center}
.pm-inline .pm-input{flex:1}
.pm-drop{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:22px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;transition:border-color .16s,color .16s,background .16s;cursor:pointer}
.pm-drop.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.pm-drop b{display:block;font-size:14px;margin-bottom:4px;font-weight:600}
.pm-feed{display:flex;flex-direction:column;gap:3px;max-height:126px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);padding:6px 10px}
.pm-feed-item{display:flex;flex-direction:column;gap:3px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.pm-feed-line{display:flex;align-items:baseline;gap:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-feed-item.error .pm-feed-line{white-space:normal;overflow:visible;flex-wrap:wrap;align-items:flex-start}
.pm-feed-item.ok{color:var(--dsw-alias-state-success-primary)}
.pm-feed-item.warn{color:var(--dsw-alias-state-warn-primary)}
.pm-feed-item.error{color:var(--dsw-alias-state-error-primary)}
.pm-error-full{border:1px solid var(--dsw-alias-label-error);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.pm-error-full b{font-size:12px;color:var(--dsw-alias-label-error);font-weight:600}
.pm-error-full pre{margin:0;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.pm-feed-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
.pm-feed-item.error .pm-feed-text{white-space:pre-wrap;word-break:break-all;overflow:visible;flex:1 1 100%}
.pm-feed-pct{margin-left:auto;flex:0 0 auto;font-weight:600;color:var(--dsw-alias-label-secondary);font-size:10px}
.pm-feed-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;align-self:center;background:var(--dsw-alias-label-tertiary)}
.pm-feed-dot.queued{background:var(--dsw-alias-state-warn-primary)}
.pm-feed-dot.running{background:var(--dsw-alias-state-business-primary)}
.pm-feed-dot.success{background:var(--dsw-alias-state-success-primary)}
.pm-feed-dot.failed{background:var(--dsw-alias-state-error-primary)}
.pm-bar-track{height:3px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden}
.pm-bar{height:100%;width:0;border-radius:2px;background:var(--dsw-alias-state-business-primary);transition:width .25s ease}
.pm-bar.success{background:var(--dsw-alias-state-success-primary)}
.pm-bar.failed{background:var(--dsw-alias-state-error-primary)}
.pm-bar.queued{background:var(--dsw-alias-state-warn-primary)}
.pm-row{flex-direction:column;gap:6px;padding:10px 0;min-width:0;display:flex}
.pm-row + .pm-row{border-top:1px solid var(--dsw-alias-border-l2)}
.pm-row-head{align-items:center;gap:8px;min-width:0;display:flex}
.pm-id{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-chip-btn{appearance:none;border:0;background:0 0;cursor:pointer;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:0 2px}
.pm-chip-btn:hover{color:var(--dsw-alias-label-error)}
`

    const zh = {
      'nav': '插件管理',
      'title': '插件管理',
      'tabs.manage': '管理插件',
      'tabs.download': '插件安装',
      'tabs.develop': '开发插件',
      'tabs.packages': '插件包',
      'loading': '加载中…',
      'empty': '（空）',
      'noMatch': '（无匹配）',
      'noPlugins': '（没有读取到任何插件）',
      'noUserPlugins': '（没有用户插件）',
      'noGroups': '（暂无分组）',
      'source.native': '原生',
      'source.user': '用户',
      'source.injected': '临时注入',
      'state.disabled': '已禁用',
      'state.active': '运行中',
      'state.failed': '失败',
      'state.notLoaded': '未加载',
      'pending.uninstall': '待重启卸载',
      'pending.disable': '待重启禁用',
      'pending.enable': '待重启启用',
      'pending.count': '待重启 {count}',
      'action.enable': '启用',
      'action.disable': '禁用',
      'action.update': '更新',
      'action.uninstall': '卸载',
      'action.cancelUninstall': '取消卸载',
      'action.readonly': '只读',
      'action.save': '保存',
      'action.delete': '删除',
      'action.cancel': '取消',
      'action.install': '安装',
      'action.installing': '安装中…',
      'action.export': '导出插件包',
      'action.exporting': '导出中…',
      'action.saveGroup': '保存分组',
      'action.saving': '保存中…',
      'action.delegateAi': '交给 AI 配置',
      'action.delegated': '已交给 AI…',
      'action.retry': '重试',
      'confirm.uninstall': '确定卸载「{name}」？配置会在重启 DSH 后生效。',
      'confirm.deleteGroup': '删除分组「{name}」？（不会卸载插件，只是取消分组）',
      'realId': '实际 id: {id}',
      'expand': '展开: {title}',
      'collapse': '折叠: {title}',
      'manage.intro': '操作只写入 profile 配置（cordis.patch.yml / package.json），当前进程不动，重启 DSH 后生效；原生插件不可卸载。',
      'manage.searchPlaceholder': '搜索插件 id / 包名…',
      'manage.all': '全部',
      'manage.ungrouped': '未分组',
      'manage.matchCount': '匹配 {matched} / 共 {total}',
      'manage.itemCount': '{count} 个',
      'manage.groupEnable': '整组启用',
      'manage.groupDisable': '整组禁用',
      'manage.asIs': '保持现状',
      'manage.desired.enabled': '整组启用',
      'manage.desired.disabled': '整组禁用',
      'manage.configPath': '配置位置：{path} · 刷新间隔 15s',
      'install.intro': '三种安装方式，任选其一：本地目录 / 拖入 .tgz 压缩包 / GitHub 地址或 npm 指令。安装后立即生效，并写入 profile 持久化（重启仍在）。',
      'install.allowBuild': '允许执行构建脚本（仅对缺少 lib/ 的包生效；会执行该来源的 npm install / 构建脚本，请确认来源可信）',
      'install.local.title': '① 本地目录',
      'install.local.desc': '填写插件项目目录（含 package.json 与 lib/，支持 Windows 或 WSL 路径），未构建会自动尝试构建。',
      'install.local.placeholder': '例如 C:\\Users\\Administrator\\my-plugin 或 /mnt/c/...',
      'install.local.required': '请填写插件目录路径',
      'install.tgz.title': '② 拖拽压缩包',
      'install.tgz.desc': '把 .tgz / .tar.gz 插件包拖进下面区域，松手即自动上传安装。',
      'install.tgz.drop': '拖拽 .tgz 到这里',
      'install.tgz.dropReady': '松开立即安装',
      'install.tgz.uploading': '正在安装，请稍候…',
      'install.tgz.hint': '松手即自动安装，无需点击按钮',
      'install.tgz.only': '仅支持 .tgz / .tar.gz 压缩包',
      'install.tgz.uploadingFile': '正在上传并安装 {file} …',
      'install.source.title': '③ GitHub 地址 / npm 指令',
      'install.source.desc': 'GitHub 仓库会自动 clone + 构建；npm 会执行 npm pack 后安装。二者共用一个输入框，自动识别。',
      'install.source.placeholder': 'https://github.com/user/repo 或 npm install some-package',
      'install.source.required': '请填写 GitHub 地址或 npm 包名/安装指令',
      'install.success': '安装成功',
      'install.success.names': '安装成功 · {names}',
      'install.success.named': '安装成功：{names}',
      'install.failed': '安装失败：#{id}（完整原因见下方红色面板）',
      'install.failPanel': '#{id} 安装/更新失败 · {label}',
      'install.queued': '排队中 · {label}',
      'install.preparing': '准备中…',
      'install.unknownError': '未知错误',
      'install.uploadFailed': '上传失败: {error}',
      'install.submitFailed': '提交失败',
      'install.requestFailed': '请求失败: {error}',
      'install.delegateFailed': '交给 AI 配置失败',
      'install.delegatedOk': '已交给 AI 配置',
      'install.saved': '已写入配置，重启 DSH 后生效',
      'develop.title': '开发插件',
      'develop.desc': '生成插件骨架、构建、注入调试 —— 暂未开放。',
      'packages.intro': '把已安装的用户插件（无论启用/禁用）加入分组，导出为 .tgz 插件包。插件包可在「插件安装」Tab 拖入一键安装，安装后自动恢复分组。',
      'packages.create.title': '① 勾选插件 → 创建/更新分组',
      'packages.create.groupNamePlaceholder': '分组名（例如：工具组 / 面板组）',
      'packages.searchPlaceholder': '搜索插件…',
      'packages.create.groupNameRequired': '请填写分组名',
      'packages.create.selectRequired': '请先勾选要加入分组的插件（一个插件可以同时属于多个分组）',
      'packages.create.hint': '勾选的插件会加入上面填写的分组；插件可以同时属于多个分组，导出插件包时交集只内嵌一份。',
      'packages.create.saved': '已保存分组「{name}」（{count} 个插件；多归属，交集在导出时自动去重）',
      'packages.create.saveFailed': '保存分组失败',
      'packages.list.title': '② 已有分组',
      'packages.list.removeOk': '已从分组「{group}」移除 {plugin}',
      'packages.list.removeFailed': '移除失败',
      'packages.list.deleted': '已删除分组「{name}」',
      'packages.list.deleteFailed': '删除失败',
      'packages.list.groupFailed': '整组操作失败',
      'packages.list.pendingOk': '已写入待重启队列',
      'packages.list.count': '{count} 个插件',
      'packages.export.title': '③ 导出插件包',
      'packages.export.desc': '导出所有分组为 .tgz（浏览器下载）。包内含 package.json + manifest.yml + plugins/，可在「插件安装」Tab 拖入安装。',
      'packages.export.packNamePlaceholder': '包名（默认 my-dsh-pack）',
      'packages.export.selectGroups': '选择要导出的分组（{selected}/{total}）',
      'packages.export.noneSelected': '请至少选择一个要导出的分组',
      'packages.export.required': '还没有可导出的分组（请先创建分组并加入插件）',
      'packages.export.building': '正在打包并下载 {name}.tgz …',
      'packages.export.failed': '导出失败',
      'packages.export.done': '已导出 {name}.tgz（浏览器下载）。可在「插件安装」Tab 拖入该包一键安装，安装后自动恢复分组。',
      'op.failed': '{label} 失败',
      'list.failed': 'list 失败',
      'load.failed': '加载失败: {error}',
      'placeholder.desc': '该模块尚未开放，将在后续版本提供。',
    }

    const en = {
      'nav': 'Plugin Manager',
      'title': 'Plugin Manager',
      'tabs.manage': 'Plugins',
      'tabs.download': 'Install',
      'tabs.develop': 'Develop',
      'tabs.packages': 'Packs',
      'loading': 'Loading…',
      'empty': '(empty)',
      'noMatch': '(no matches)',
      'noPlugins': '(no plugins found)',
      'noUserPlugins': '(no user plugins)',
      'noGroups': '(no groups yet)',
      'source.native': 'native',
      'source.user': 'user',
      'source.injected': 'injected',
      'state.disabled': 'disabled',
      'state.active': 'active',
      'state.failed': 'failed',
      'state.notLoaded': 'not loaded',
      'pending.uninstall': 'uninstall on restart',
      'pending.disable': 'disable on restart',
      'pending.enable': 'enable on restart',
      'pending.count': '{count} pending',
      'action.enable': 'Enable',
      'action.disable': 'Disable',
      'action.update': 'Update',
      'action.uninstall': 'Uninstall',
      'action.cancelUninstall': 'Cancel uninstall',
      'action.readonly': 'read-only',
      'action.save': 'Save',
      'action.delete': 'Delete',
      'action.cancel': 'Cancel',
      'action.install': 'Install',
      'action.installing': 'Installing…',
      'action.export': 'Export pack',
      'action.exporting': 'Exporting…',
      'action.saveGroup': 'Save group',
      'action.saving': 'Saving…',
      'action.delegateAi': 'Hand to AI',
      'action.delegated': 'Handed to AI…',
      'action.retry': 'Retry',
      'confirm.uninstall': 'Uninstall "{name}"? The change takes effect after DSH restarts.',
      'confirm.deleteGroup': 'Delete group "{name}"? (plugins are not uninstalled, only the grouping is removed)',
      'realId': 'actual id: {id}',
      'expand': 'Expand: {title}',
      'collapse': 'Collapse: {title}',
      'manage.intro': 'Operations only write the profile config (cordis.patch.yml / package.json); the running process is untouched and changes apply after DSH restarts. Native plugins cannot be uninstalled.',
      'manage.searchPlaceholder': 'Search plugin id / package name…',
      'manage.all': 'All',
      'manage.ungrouped': 'Ungrouped',
      'manage.matchCount': '{matched} / {total} matched',
      'manage.itemCount': '{count}',
      'manage.groupEnable': 'Enable group',
      'manage.groupDisable': 'Disable group',
      'manage.asIs': 'as-is',
      'manage.desired.enabled': 'group enabled',
      'manage.desired.disabled': 'group disabled',
      'manage.configPath': 'Config: {path} · refresh every 15s',
      'install.intro': 'Pick one of three install paths: local directory, drag a .tgz in, or a GitHub URL / npm command. Installs activate immediately and persist into the profile.',
      'install.allowBuild': 'Allow build scripts (only for packages missing lib/; runs the source\'s npm install / build scripts — only for sources you trust)',
      'install.local.title': '① Local directory',
      'install.local.desc': 'Path to a plugin project (with package.json and lib/; Windows or WSL paths are supported). Missing lib/ will attempt a build.',
      'install.local.placeholder': 'e.g. C:\\Users\\Administrator\\my-plugin or /mnt/c/...',
      'install.local.required': 'Please enter the plugin directory path',
      'install.tgz.title': '② Drop a tarball',
      'install.tgz.desc': 'Drag a .tgz / .tar.gz pack into the area below; it uploads and installs on drop.',
      'install.tgz.drop': 'Drop a .tgz here',
      'install.tgz.dropReady': 'Release to install',
      'install.tgz.uploading': 'Installing, please wait…',
      'install.tgz.hint': 'Dropping installs immediately — no button needed',
      'install.tgz.only': 'Only .tgz / .tar.gz archives are supported',
      'install.tgz.uploadingFile': 'Uploading and installing {file} …',
      'install.source.title': '③ GitHub URL / npm command',
      'install.source.desc': 'GitHub repos are cloned and built automatically; npm runs npm pack before installing. One input auto-detects both.',
      'install.source.placeholder': 'https://github.com/user/repo or npm install some-package',
      'install.source.required': 'Please enter a GitHub URL or npm package/command',
      'install.success': 'Installed',
      'install.success.names': 'Installed · {names}',
      'install.success.named': 'Installed: {names}',
      'install.failed': 'Install failed: #{id} (see the red panel below)',
      'install.failPanel': '#{id} install/update failed · {label}',
      'install.queued': 'Queued · {label}',
      'install.preparing': 'Preparing…',
      'install.unknownError': 'Unknown error',
      'install.uploadFailed': 'Upload failed: {error}',
      'install.submitFailed': 'Submit failed',
      'install.requestFailed': 'Request failed: {error}',
      'install.delegateFailed': 'Handing to AI failed',
      'install.delegatedOk': 'Handed to AI',
      'install.saved': 'Saved to profile config; applies after DSH restarts',
      'develop.title': 'Develop plugins',
      'develop.desc': 'Scaffolding, building and injection debugging — not open yet.',
      'packages.intro': 'Group installed user plugins (enabled or disabled) and export them as a .tgz pack. Drop the pack in the Install tab to restore groups automatically.',
      'packages.create.title': '① Select plugins → create/update group',
      'packages.create.groupNamePlaceholder': 'Group name (e.g. tools / panels)',
      'packages.searchPlaceholder': 'Search plugins…',
      'packages.create.groupNameRequired': 'Please enter a group name',
      'packages.create.selectRequired': 'Select plugins to add (a plugin may belong to several groups)',
      'packages.create.hint': 'Selected plugins join the group above; plugins may belong to multiple groups, and export deduplicates intersections into one copy.',
      'packages.create.saved': 'Group "{name}" saved ({count} plugins; multi-membership, intersections deduplicated on export)',
      'packages.create.saveFailed': 'Failed to save group',
      'packages.list.title': '② Existing groups',
      'packages.list.removeOk': 'Removed {plugin} from group "{group}"',
      'packages.list.removeFailed': 'Failed to remove',
      'packages.list.deleted': 'Group "{name}" deleted',
      'packages.list.deleteFailed': 'Failed to delete group',
      'packages.list.groupFailed': 'Group operation failed',
      'packages.list.pendingOk': 'Written to the restart queue',
      'packages.list.count': '{count} plugins',
      'packages.export.title': '③ Export pack',
      'packages.export.desc': 'Export all groups as a .tgz download. The pack contains package.json + manifest.yml + plugins/, installable via the Install tab.',
      'packages.export.packNamePlaceholder': 'Pack name (default my-dsh-pack)',
      'packages.export.selectGroups': 'Select groups to export ({selected}/{total})',
      'packages.export.noneSelected': 'Select at least one group to export',
      'packages.export.required': 'No exportable groups yet (create a group with plugins first)',
      'packages.export.building': 'Packing and downloading {name}.tgz …',
      'packages.export.failed': 'Export failed',
      'packages.export.done': 'Exported {name}.tgz. Drop it in the Install tab to install and restore groups.',
      'op.failed': '{label} failed',
      'list.failed': 'list failed',
      'load.failed': 'Load failed: {error}',
      'placeholder.desc': 'This module is not open yet and will ship in a later version.',
    }

    function fetchJson(path, init) {
      return fetch(API + path, {
        headers: { 'content-type': 'application/json' },
        ...(init || {}),
      }).then((r) => r.json())
    }

    /** 装配行没有固定 id 时会得到短 hash（如 85cb9046）；从包名派生友好短名用于主显示 */
    function friendlyName(name) {
      const base = String(name).split('/').pop() || String(name)
      return base.replace(/^dsh-/, '').replace(/^cordis-plugin-/, '') || String(name)
    }

    function displayId(item) {
      const id = item.id.startsWith('include:') ? item.id.slice('include:'.length) : item.id
      const isHash = /^[0-9a-f]{6,10}$/.test(id)
      const isPackage = !item.name.includes('/') || item.name.startsWith('@')
      return isHash && isPackage ? friendlyName(item.name) : id
    }

    function realId(item) {
      const id = item.id.startsWith('include:') ? item.id.slice('include:'.length) : item.id
      return id === displayId(item) ? '' : id
    }

    function phaseLabel(t, phase, enabled) {
      if (!enabled) return { text: t('state.disabled'), cls: 'off' }
      if (phase === 'active') return { text: t('state.active'), cls: 'on' }
      if (phase === 'failed') return { text: t('state.failed'), cls: 'failed' }
      if (phase === 'pending' || phase === 'loading' || phase === 'unloading') return { text: phase, cls: 'pending' }
      return { text: t('state.notLoaded'), cls: 'off' }
    }

    const TABS = [
      { key: 'manage', label: 'tabs.manage' },
      { key: 'download', label: 'tabs.download' },
      { key: 'develop', label: 'tabs.develop' },
      { key: 'packages', label: 'tabs.packages' },
    ]

    function Placeholder({ t, title, desc }) {
      return jsxs('div', {
        className: 'pm-placeholder',
        children: [
          jsx('b', { children: title }),
          jsx('span', { children: desc || t('placeholder.desc') }),
        ],
      })
    }

    function sourceBadge(t, source) {
      const key = source === 'native' ? 'source.native' : source === 'user' ? 'source.user' : 'source.injected'
      return jsx('span', { className: 'pm-badge', children: t(key) })
    }

    function pendingText(t, item) {
      if (!item.pending) return null
      const key = item.desired === 'removed' ? 'pending.uninstall' : item.desired === 'disabled' ? 'pending.disable' : 'pending.enable'
      return jsx('span', { className: 'pm-st pending', children: t(key) })
    }

    /** 官方 PluginCard 模式：li > button 折叠头 + body + footer，单列列表 */
    function PluginRow({ t, item, busy, onAction }) {
      const [open, setOpen] = useState(false)
      const ph = phaseLabel(t, item.running.fiberPhase, item.running.enabled)
      const showUninstall = item.source === 'user' && !(item.pending && item.desired === 'removed')
      const canToggle = item.source !== 'injected' && !(item.pending && item.desired === 'removed')
      const showCancelUninstall = item.source === 'user' && item.pending && item.desired === 'removed'
      const showUpdate = item.source === 'user' && !(item.pending && item.desired === 'removed')
      const toggleLabel = item.desired === 'disabled' ? t('action.enable') : t('action.disable')
      const togglePath = item.desired === 'disabled' ? '/enable' : '/disable'
      const title = displayId(item)
      const meta = realId(item) ? item.name + ' · ' + t('realId', { id: realId(item) }) : item.name
      return jsxs('li', {
        className: 'pm-plugin-card' + (open ? ' open' : ''),
        children: [
          jsx('button', {
            type: 'button',
            className: 'pm-pc-head',
            'aria-expanded': open,
            'aria-label': t(open ? 'collapse' : 'expand', { title }),
            onClick: () => setOpen(!open),
            children: [
              jsxs('span', {
                className: 'pm-pc-headtext',
                children: [
                  jsx('span', { className: 'pm-pc-name', title: item.name, children: title }),
                  jsx('span', { className: 'pm-pc-desc', children: meta }),
                ],
              }),
              jsx('span', {
                className: 'pm-pc-badges',
                children: [
                  sourceBadge(t, item.source),
                  jsx('span', { className: 'pm-st ' + ph.cls, children: ph.text }),
                  pendingText(t, item),
                ],
              }),
              jsx('span', { className: 'pm-pc-chevron' + (open ? ' open' : ''), children: jsx(IconChevronDownOutline14, {}) }),
            ],
          }),
          open
            ? jsxs('div', {
                className: 'pm-pc-body',
                children: [
                  jsxs('div', {
                    className: 'pm-pc-badges',
                    children: [
                      (item.groups || []).map((g) => jsx('span', { key: g, className: 'pm-badge', children: g })),
                      item.version ? jsx('span', { className: 'pm-badge muted', children: 'v' + item.version }) : null,
                    ],
                  }),
                  item.ephemeral ? jsx('p', { className: 'pm-hint', children: item.ephemeral }) : null,
                  jsxs('div', {
                    className: 'pm-pc-footer',
                    children: [
                      canToggle
                        ? jsx('button', {
                            type: 'button',
                            className: 'pm-btn pm-btn-primary',
                            disabled: busy !== null,
                            onClick: () => onAction(togglePath, item.id, toggleLabel),
                            children: toggleLabel,
                          })
                        : null,
                      showUpdate
                        ? jsx('button', {
                            type: 'button',
                            className: 'pm-btn',
                            disabled: busy !== null,
                            onClick: () => onAction('/update', item.id, t('action.update')),
                            children: t('action.update'),
                          })
                        : null,
                      showUninstall
                        ? jsx('button', {
                            type: 'button',
                            className: 'pm-btn pm-btn-danger',
                            disabled: busy !== null,
                            onClick: () => {
                              if (window.confirm(t('confirm.uninstall', { name: title }))) {
                                onAction('/uninstall', item.id, t('action.uninstall'))
                              }
                            },
                            children: t('action.uninstall'),
                          })
                        : null,
                      showCancelUninstall
                        ? jsx('button', {
                            type: 'button',
                            className: 'pm-btn',
                            disabled: busy !== null,
                            onClick: () => onAction('/cancel-uninstall', item.id, t('action.cancelUninstall')),
                            children: t('action.cancelUninstall'),
                          })
                        : null,
                      item.source === 'injected' ? jsx('span', { className: 'pm-hint', children: t('action.readonly') }) : null,
                    ],
                  }),
                ],
              })
            : null,
        ],
      })
    }

    /** 紧凑实时信息流（只放进行中/刚完成）；失败任务用下方完整错误面板显示 */
    function TasksPanel({ t, tasks, onDelegateAi, delegateBusy }) {
      const now = Date.now()
      const visible = tasks.filter((task) => {
        if (task.status === 'queued' || task.status === 'running') return true
        const age = now - (task.finishedAt || 0)
        return task.status === 'success' && age < 8000
      })
      const failed = tasks
        .filter((task) => task.status === 'failed' && now - (task.finishedAt || 0) < 300000)
        .sort((a, b) => b.finishedAt - a.finishedAt)

      const rows = visible
        .map((task) => ({ task, step: task.steps[task.steps.length - 1] }))
        .sort((a, b) => {
          const ts = (x) => (x.step ? x.step.ts : x.task.createdAt)
          return ts(b) - ts(a)
        })
        .slice(0, 8)

      const clock = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour12: false })
      const textOf = (task, step) => {
        if (task.status === 'success') {
          const names = (task.result || []).map((r) => r.name).filter(Boolean).join(', ')
          return names ? t('install.success.names', { names }) : t('install.success')
        }
        if (task.status === 'queued') return t('install.queued', { label: task.label })
        return step ? step.text : t('install.preparing')
      }
      const levelOf = (task, step) => {
        if (step && step.level !== 'info') return step.level
        if (task.status === 'success') return 'ok'
        return ''
      }
      const toneOf = (task, step) => {
        if (step && step.level === 'error') return 'failed'
        if (step && step.level === 'warn') return 'queued'
        return task.status
      }

      const feed = rows.length
        ? jsx('div', {
            className: 'pm-feed',
            children: rows.map(({ task, step }) =>
              jsx('div', {
                key: task.id,
                className: 'pm-feed-item ' + levelOf(task, step),
                children: [
                  jsxs('div', {
                    className: 'pm-feed-line',
                    children: [
                      jsx('span', { className: 'pm-feed-dot ' + toneOf(task, step) }),
                      jsx('b', { children: '#' + task.id }),
                      jsx('span', { children: clock(step ? step.ts : task.createdAt) }),
                      jsx('span', { className: 'pm-feed-text', children: textOf(task, step) }),
                      jsx('span', { className: 'pm-feed-pct', children: task.progress + '%' }),
                    ],
                  }),
                  jsx('div', {
                    className: 'pm-bar-track',
                    children: jsx('div', {
                      className: 'pm-bar ' + toneOf(task, step),
                      style: { width: task.progress + '%' },
                    }),
                  }),
                ],
              }),
            ),
          })
        : null

      const errorPanel = failed.length
        ? jsxs('div', {
            className: 'pm-error-full',
            children: [
              jsx('b', { children: t('install.failPanel', { id: failed[0].id, label: failed[0].label }) }),
              jsx('pre', { children: failed[0].error || t('install.unknownError') }),
              jsx('div', {
                className: 'pm-actions',
                children: jsx('button', {
                  type: 'button',
                  className: 'pm-btn pm-btn-danger',
                  disabled: delegateBusy !== null,
                  onClick: () => onDelegateAi(failed[0].id),
                  children: delegateBusy === 'delegate:' + failed[0].id ? t('action.delegated') : t('action.delegateAi'),
                }),
              }),
            ],
          })
        : null

      if (!feed && !errorPanel) return null
      return jsxs('div', { children: [errorPanel, feed] })
    }

    function InstallTab({ t, onRefresh, onDelegateAi, delegateBusy }) {
      const [dir, setDir] = useState('')
      const [source, setSource] = useState('')
      const [dragging, setDragging] = useState(false)
      const [busy, setBusy] = useState(null)
      const [msg, setMsg] = useState(null)
      const [buildOk, setBuildOk] = useState(false)
      const [tasks, setTasks] = useState([])
      const notifiedRef = useRef(new Set())

      const pollTasks = useCallback(() => {
        fetchJson('/install-tasks')
          .then((r) => {
            if (!r || r.ok === false) return
            const list = r.tasks || []
            setTasks(list)
            const now = Date.now()
            for (const task of list) {
              if (notifiedRef.current.has(task.id)) continue
              if (task.status === 'success' && now - (task.finishedAt || 0) < 3000) {
                notifiedRef.current.add(task.id)
                const names = (task.result || []).map((x) => x.name).filter(Boolean).join(', ')
                setMsg({ text: names ? t('install.success.named', { names }) : t('install.success'), isErr: false })
              } else if (task.status === 'failed' && now - (task.finishedAt || 0) < 3000) {
                notifiedRef.current.add(task.id)
                setMsg({ text: t('install.failed', { id: task.id }), isErr: true })
              }
            }
          })
          .catch(() => {})
      }, [t])

      useEffect(() => {
        pollTasks()
        const timer = window.setInterval(pollTasks, 800)
        return () => window.clearInterval(timer)
      }, [pollTasks])

      const finish = (r, okText) => {
        if (!r || r.ok === false) {
          setMsg({ text: (r && r.error) || okText, isErr: true })
          return false
        }
        setMsg({ text: (r.result && r.result.message) || okText, isErr: false })
        pollTasks()
        if (onRefresh) onRefresh()
        return true
      }

      const installLocal = () => {
        if (!dir.trim()) {
          setMsg({ text: t('install.local.required'), isErr: true })
          return
        }
        setBusy('local')
        setMsg(null)
        fetchJson('/install-local', { method: 'POST', body: JSON.stringify({ path: dir.trim(), allowBuild: buildOk }) })
          .then((r) => finish(r, t('install.success')))
          .catch((err) => setMsg({ text: t('install.requestFailed', { error: err }), isErr: true }))
          .finally(() => setBusy(null))
      }

      const installSource = () => {
        if (!source.trim()) {
          setMsg({ text: t('install.source.required'), isErr: true })
          return
        }
        setBusy('source')
        setMsg(null)
        fetchJson('/install-source', { method: 'POST', body: JSON.stringify({ source: source.trim(), allowBuild: buildOk }) })
          .then((r) => finish(r, t('install.success')))
          .catch((err) => setMsg({ text: t('install.requestFailed', { error: err }), isErr: true }))
          .finally(() => setBusy(null))
      }

      const uploadFile = (file) => {
        if (!file) return
        if (!/\.(tgz|tar\.gz)$/i.test(file.name)) {
          setMsg({ text: t('install.tgz.only'), isErr: true })
          return
        }
        setBusy('drop')
        setMsg({ text: t('install.tgz.uploadingFile', { file: file.name }), isErr: false })
        fetch(API + '/install-tgz', {
          method: 'POST',
          headers: { 'x-file-name': encodeURIComponent(file.name), 'x-allow-build': buildOk ? 'true' : 'false' },
          body: file,
        })
          .then((r) => r.json())
          .then((r) => finish(r, t('install.success')))
          .catch((err) => setMsg({ text: t('install.uploadFailed', { error: err }), isErr: true }))
          .finally(() => setBusy(null))
      }

      return jsxs('div', {
        className: 'pm-install',
        children: [
          jsx('p', { className: 'pm-intro', children: t('install.intro') }),
          jsx('label', {
            className: 'pm-hint',
            style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' },
            children: [
              jsx('input', {
                type: 'checkbox',
                checked: buildOk,
                onChange: (e) => setBuildOk(e.target.checked),
              }),
              jsx('span', { children: t('install.allowBuild') }),
            ],
          }),
          jsx(TasksPanel, { t, tasks, onDelegateAi, delegateBusy }),
          jsxs('div', {
            className: 'pm-card',
            children: [
              jsx('h3', { className: 'pm-card-title', children: t('install.local.title') }),
              jsx('p', { className: 'pm-card-desc', children: t('install.local.desc') }),
              jsxs('div', {
                className: 'pm-inline',
                children: [
                  jsx('input', {
                    className: 'pm-input',
                    placeholder: t('install.local.placeholder'),
                    value: dir,
                    onChange: (e) => setDir(e.target.value),
                  }),
                  jsx('button', {
                    type: 'button',
                    className: 'pm-btn pm-btn-primary',
                    disabled: busy !== null,
                    onClick: installLocal,
                    children: busy === 'local' ? t('action.installing') : t('action.install'),
                  }),
                ],
              }),
            ],
          }),
          jsxs('div', {
            className: 'pm-card',
            children: [
              jsx('h3', { className: 'pm-card-title', children: t('install.tgz.title') }),
              jsx('p', { className: 'pm-card-desc', children: t('install.tgz.desc') }),
              jsx('div', {
                className: 'pm-drop' + (dragging ? ' on' : ''),
                onDragOver: (e) => {
                  e.preventDefault()
                  setDragging(true)
                },
                onDragLeave: () => setDragging(false),
                onDrop: (e) => {
                  e.preventDefault()
                  setDragging(false)
                  uploadFile(e.dataTransfer.files && e.dataTransfer.files[0])
                },
                children: [
                  jsx('b', { children: dragging ? t('install.tgz.dropReady') : t('install.tgz.drop') }),
                  jsx('span', { children: busy === 'drop' ? t('install.tgz.uploading') : t('install.tgz.hint') }),
                ],
              }),
            ],
          }),
          jsxs('div', {
            className: 'pm-card',
            children: [
              jsx('h3', { className: 'pm-card-title', children: t('install.source.title') }),
              jsx('p', { className: 'pm-card-desc', children: t('install.source.desc') }),
              jsxs('div', {
                className: 'pm-inline',
                children: [
                  jsx('input', {
                    className: 'pm-input',
                    placeholder: t('install.source.placeholder'),
                    value: source,
                    onChange: (e) => setSource(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') installSource()
                    },
                  }),
                  jsx('button', {
                    type: 'button',
                    className: 'pm-btn pm-btn-primary',
                    disabled: busy !== null,
                    onClick: installSource,
                    children: busy === 'source' ? t('action.installing') : t('action.install'),
                  }),
                ],
              }),
            ],
          }),
          msg
            ? jsx('div', {
                className: 'pm-msg' + (msg.isErr ? ' err' : ''),
                children: msg.text,
              })
            : null,
        ],
      })
    }

    function ManageTab({ t, data, busy, onAction, onGroupApply }) {
      const [search, setSearch] = useState('')
      const [collapsed, setCollapsed] = useState({})
      const [groupFilter, setGroupFilter] = useState('')
      const items = (data && data.items) || []
      const groups = (data && data.groups) || []
      const nativeAll = items.filter((i) => i.source === 'native')
      const userAll = items.filter((i) => i.source !== 'native' && !(i.groups && i.groups.length))
      const pendingCount = items.filter((i) => i.pending).length

      const q = search.trim().toLowerCase()
      const match = (i) => !q || displayId(i).toLowerCase().includes(q) || i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q)
      const groupsOf = (i) => (i.groups && i.groups.length ? i.groups : [])
      const matchGroup = (i) => {
        if (!groupFilter) return true
        if (groupFilter === '__none') return groupsOf(i).length === 0
        return groupsOf(i).includes(groupFilter)
      }
      const nativeItems = nativeAll.filter((i) => match(i) && matchGroup(i))
      const userItems = userAll.filter((i) => match(i) && matchGroup(i))
      const searching = q.length > 0

      const group = (key, title, all, filtered, extra) => {
        // 默认全部折叠：只有用户显式展开（记录 false）才展开
        const isCollapsed = collapsed[key] !== false
        const count = searching ? t('manage.matchCount', { matched: filtered.length, total: all.length }) : t('manage.itemCount', { count: all.length })
        return jsxs('div', {
          className: 'pm-group',
          children: [
            jsxs('div', {
              className: 'pm-group-head-row',
              children: [
                jsx('button', {
                  type: 'button',
                  className: 'pm-group-head',
                  'aria-expanded': !isCollapsed,
                  onClick: () => setCollapsed((c) => ({ ...c, [key]: !c[key] })),
                  children: [
                    jsx('span', {
                      className: 'pm-caret',
                      style: { transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform .16s' },
                      children: jsx(IconChevronDownOutline14, {}),
                    }),
                    jsx('span', { className: 'pm-group-title', children: title }),
                    jsx('span', { className: 'pm-group-count', children: count }),
                  ],
                }),
                extra || null,
              ],
            }),
            isCollapsed
              ? null
              : filtered.length === 0
                ? jsx('p', { className: 'pm-empty', children: searching ? t('noMatch') : t('empty') })
                : jsx('ul', {
                    className: 'pm-plugin-grid',
                    children: filtered.map((item) => jsx(PluginRow, { key: item.id, t, item, busy, onAction })),
                  }),
          ],
        })
      }

      const groupChips = groups.length
        ? jsx('div', {
            className: 'pm-groups-bar',
            children: [
              jsx('button', {
                type: 'button',
                className: 'pm-group-chip' + (groupFilter === '' ? ' on' : ''),
                onClick: () => setGroupFilter(''),
                children: t('manage.all'),
              }),
              jsx('button', {
                type: 'button',
                className: 'pm-group-chip' + (groupFilter === '__none' ? ' on' : ''),
                onClick: () => setGroupFilter('__none'),
                children: t('manage.ungrouped'),
              }),
            ].concat(
              groups.map((g) =>
                jsx('button', {
                  type: 'button',
                  key: g.name,
                  className: 'pm-group-chip' + (groupFilter === g.name ? ' on' : ''),
                  onClick: () => setGroupFilter(g.name === groupFilter ? '' : g.name),
                  children: g.name + ' · ' + g.plugins.length,
                }),
              ),
            ),
          })
        : null

      const groupSectionExtra = (g) => {
        return jsxs('div', {
          className: 'pm-actions',
          children: [
            jsx('button', {
              type: 'button',
              className: 'pm-btn',
              disabled: busy !== null,
              onClick: () => onGroupApply(g.name, 'enable'),
              children: t('manage.groupEnable'),
            }),
            jsx('button', {
              type: 'button',
              className: 'pm-btn',
              disabled: busy !== null,
              onClick: () => onGroupApply(g.name, 'disable'),
              children: t('manage.groupDisable'),
            }),
          ],
        })
      }

      return jsxs('div', {
        className: 'pm-manage',
        children: [
          jsx('p', { className: 'pm-intro', children: t('manage.intro') }),
          pendingCount > 0
            ? jsx('div', {
                className: 'pm-badges',
                children: jsx('span', { className: 'pm-st pending', children: t('pending.count', { count: pendingCount }) }),
              })
            : null,
          jsx('input', {
            className: 'pm-search',
            placeholder: t('manage.searchPlaceholder'),
            value: search,
            onChange: (e) => setSearch(e.target.value),
          }),
          groupChips,
          data === null
            ? jsx('p', { className: 'pm-empty', children: t('loading') })
            : items.length === 0
              ? jsx('p', { className: 'pm-empty', children: t('noPlugins') })
              : jsxs('div', {
                  children: [
                    group('native', t('source.native'), nativeAll, nativeItems),
                    group('user', t('manage.ungrouped'), userAll, userItems),
                  ].concat(
                    groups.map((g) => {
                      const all = items.filter((i) => groupsOf(i).includes(g.name))
                      const filtered = all.filter((i) => match(i) && matchGroup(i))
                      return group(g.name, g.name, all, filtered, groupSectionExtra(g))
                    }),
                  ),
                }),
          jsx('p', { className: 'pm-hint', children: data ? t('manage.configPath', { path: data.patchPath }) : '' }),
        ],
      })
    }

    function PackagesTab({ t, data, onRefresh }) {
      const [groupName, setGroupName] = useState('')
      const [selected, setSelected] = useState({})
      const [packName, setPackName] = useState('my-dsh-pack')
      const [pluginSearch, setPluginSearch] = useState('')
      const [exportOpen, setExportOpen] = useState(false)
      const [exportSelection, setExportSelection] = useState({})
      const [busy, setBusy] = useState(null)
      const [msg, setMsg] = useState(null)
      const items = (data && data.items) || []
      const groups = (data && data.groups) || []
      const userItems = items.filter((i) => i.source === 'user')
      const pluginQuery = pluginSearch.trim().toLowerCase()
      const visibleUserItems = userItems.filter((i) =>
        !pluginQuery ||
        displayId(i).toLowerCase().includes(pluginQuery) ||
        i.name.toLowerCase().includes(pluginQuery) ||
        i.id.toLowerCase().includes(pluginQuery),
      )
      const selectedNames = Object.keys(selected).filter((k) => selected[k])

      const postJson = (path, body) =>
        fetchJson(path, { method: 'POST', body: JSON.stringify(body) })

      const toggle = (name) => setSelected((s) => ({ ...s, [name]: !s[name] }))

      const saveGroup = () => {
        const name = groupName.trim()
        if (!name) {
          setMsg({ text: t('packages.create.groupNameRequired'), isErr: true })
          return
        }
        const plugins = selectedNames
        if (!plugins.length) {
          setMsg({ text: t('packages.create.selectRequired'), isErr: true })
          return
        }
        setBusy('save')
        postJson('/groups/upsert', { name, desired: 'as-is', plugins })
          .then((r) => {
            if (!r || r.ok === false) {
              setMsg({ text: (r && r.error) || t('packages.create.saveFailed'), isErr: true })
              return
            }
            setMsg({ text: t('packages.create.saved', { name, count: plugins.length }), isErr: false })
            setSelected({})
            if (onRefresh) onRefresh()
          })
          .catch((err) => setMsg({ text: t('install.requestFailed', { error: err }), isErr: true }))
          .finally(() => setBusy(null))
      }

      const removePlugin = (group, pluginName) => {
        setBusy('remove:' + group.name)
        postJson('/groups/upsert', {
          name: group.name,
          desired: group.desired,
          plugins: group.plugins.filter((p) => p !== pluginName),
        })
          .then((r) => {
            if (!r || r.ok === false) {
              setMsg({ text: (r && r.error) || t('packages.list.removeFailed'), isErr: true })
              return
            }
            setMsg({ text: t('packages.list.removeOk', { group: group.name, plugin: pluginName }), isErr: false })
            if (onRefresh) onRefresh()
          })
          .catch((err) => setMsg({ text: t('install.requestFailed', { error: err }), isErr: true }))
          .finally(() => setBusy(null))
      }

      const deleteGroup = (group) => {
        if (!window.confirm(t('confirm.deleteGroup', { name: group.name }))) return
        setBusy('delete:' + group.name)
        postJson('/groups/delete', { name: group.name })
          .then((r) => {
            if (!r || r.ok === false) {
              setMsg({ text: (r && r.error) || t('packages.list.deleteFailed'), isErr: true })
              return
            }
            setMsg({ text: t('packages.list.deleted', { name: group.name }), isErr: false })
            if (onRefresh) onRefresh()
          })
          .catch((err) => setMsg({ text: t('install.requestFailed', { error: err }), isErr: true }))
          .finally(() => setBusy(null))
      }

      const applyGroup = (group, op) => {
        setBusy('apply:' + group.name)
        postJson('/groups/apply', { name: group.name, op })
          .then((r) => {
            if (!r || r.ok === false) {
              setMsg({ text: (r && r.error) || t('packages.list.groupFailed'), isErr: true })
              return
            }
            setMsg({ text: (r.result && r.result.message) || t('packages.list.pendingOk'), isErr: false })
            if (onRefresh) onRefresh()
          })
          .catch((err) => setMsg({ text: t('install.requestFailed', { error: err }), isErr: true }))
          .finally(() => setBusy(null))
      }

      const exportableGroups = groups.filter((g) => g.plugins.length > 0)
      const selectedExportGroups = exportableGroups.filter((g) => exportSelection[g.name] !== false)

      const exportPack = () => {
        if (!exportableGroups.length) {
          setMsg({ text: t('packages.export.required'), isErr: true })
          return
        }
        if (!selectedExportGroups.length) {
          setMsg({ text: t('packages.export.noneSelected'), isErr: true })
          return
        }
        const name = packName.trim() || 'dsh-plugin-pack'
        const qs = '?name=' + encodeURIComponent(name) + '&groups=' + selectedExportGroups.map((g) => encodeURIComponent(g.name)).join(',')
        setBusy('export')
        setMsg({ text: t('packages.export.building', { name }), isErr: false })
        fetch(API + '/export-pack' + qs)
          .then((r) => {
            if (!r.ok) {
              return r.json().then((j) => Promise.reject(new Error((j && j.error) || t('packages.export.failed'))))
            }
            return r.blob()
          })
          .then((blob) => {
            const a = document.createElement('a')
            a.href = URL.createObjectURL(blob)
            a.download = name + '.tgz'
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            setTimeout(() => URL.revokeObjectURL(a.href), 1000)
            setMsg({ text: t('packages.export.done', { name }), isErr: false })
          })
          .catch((err) => setMsg({ text: t('packages.export.failed', { error: err }), isErr: true }))
          .finally(() => setBusy(null))
      }

      const pluginRow = (item) => {
        const checked = !!selected[item.name]
        return jsx('li', {
          key: item.id,
          className: 'pm-plugin-card',
          children: [
            jsx('label', {
              className: 'pm-pc-head pm-pick-head',
              style: { cursor: 'pointer' },
              children: [
                jsx('input', {
                  type: 'checkbox',
                  style: { flex: 'none' },
                  checked,
                  onChange: () => toggle(item.name),
                }),
                jsxs('span', {
                  className: 'pm-pc-headtext',
                  children: [
                    jsx('span', { className: 'pm-pc-name', title: item.name, children: displayId(item) }),
                    jsx('span', { className: 'pm-pc-desc', children: item.name }),
                  ],
                }),
                jsxs('span', {
                  className: 'pm-pc-badges',
                  children: [
                    item.running.enabled ? null : jsx('span', { className: 'pm-st off', children: t('state.disabled') }),
                    (item.groups || []).slice(0, 2).map((g) =>
                      jsx('span', { key: g, className: 'pm-badge pm-badge-item', children: jsx('span', { className: 'pm-badge-text', title: g, children: g }) }),
                    ),
                    item.groups && item.groups.length > 2
                      ? jsx('span', { className: 'pm-badge', children: '▣ +' + (item.groups.length - 2) })
                      : null,
                  ],
                }),
              ],
            }),
          ],
        })
      }

      return jsxs('div', {
        className: 'pm-packages',
        children: [
          jsx('p', { className: 'pm-intro', children: t('packages.intro') }),
          jsxs('div', {
            className: 'pm-card',
            children: [
              jsx('h3', { className: 'pm-card-title', children: t('packages.create.title') }),
              jsxs('div', {
                className: 'pm-inline',
                children: [
                  jsx('input', {
                    className: 'pm-input',
                    placeholder: t('packages.create.groupNamePlaceholder'),
                    value: groupName,
                    onChange: (e) => setGroupName(e.target.value),
                  }),
                  jsx('button', {
                    type: 'button',
                    className: 'pm-btn pm-btn-primary',
                    disabled: busy !== null,
                    onClick: saveGroup,
                    children: busy === 'save' ? t('action.saving') : t('action.saveGroup'),
                  }),
                ],
              }),
              jsx('p', { className: 'pm-hint', children: t('packages.create.hint') }),
              jsx('input', {
                className: 'pm-search',
                placeholder: t('packages.searchPlaceholder'),
                value: pluginSearch,
                onChange: (e) => setPluginSearch(e.target.value),
              }),
              userItems.length === 0
                ? jsx('p', { className: 'pm-empty', children: t('noUserPlugins') })
                : visibleUserItems.length === 0
                  ? jsx('p', { className: 'pm-empty', children: t('noMatch') })
                  : jsx('ul', { className: 'pm-plugin-grid pm-picker', children: visibleUserItems.map(pluginRow) }),
            ],
          }),
          jsxs('div', {
            className: 'pm-card',
            children: [
              jsx('h3', { className: 'pm-card-title', children: t('packages.list.title') }),
              groups.length === 0
                ? jsx('p', { className: 'pm-empty', children: t('noGroups') })
                : jsx('div', {
                    className: 'pm-groups-scroll',
                    children: groups.map((g) =>
                      jsxs('div', {
                        key: g.name,
                        className: 'pm-row',
                        children: [
                        jsxs('div', {
                          className: 'pm-row-head',
                          children: [
                            jsx('span', { className: 'pm-id', children: g.name }),
                            jsx('span', { className: 'pm-st pending', children: t('packages.list.count', { count: g.plugins.length }) }),
                          ],
                        }),
                        jsxs('div', {
                          className: 'pm-actions',
                          children: [
                            jsx('button', {
                              type: 'button',
                              className: 'pm-btn pm-btn-primary',
                              disabled: busy !== null,
                              onClick: () => applyGroup(g, 'enable'),
                              children: t('manage.groupEnable'),
                            }),
                            jsx('button', {
                              type: 'button',
                              className: 'pm-btn',
                              disabled: busy !== null,
                              onClick: () => applyGroup(g, 'disable'),
                              children: t('manage.groupDisable'),
                            }),
                            jsx('button', {
                              type: 'button',
                              className: 'pm-btn pm-btn-danger',
                              disabled: busy !== null,
                              onClick: () => deleteGroup(g),
                              children: t('action.delete'),
                            }),
                          ],
                        }),
                        jsx('div', {
                          className: 'pm-badges',
                          children: g.plugins.map((name) =>
                            jsx('span', {
                              key: name,
                              className: 'pm-badge pm-badge-item',
                              children: [
                                jsx('span', { className: 'pm-badge-text', title: name, children: name }),
                                jsx('button', {
                                  type: 'button',
                                  className: 'pm-chip-btn',
                                  disabled: busy !== null,
                                  onClick: () => removePlugin(g, name),
                                  children: ' ×',
                                }),
                              ],
                            }),
                          ),
                        }),
                      ],
                    }),
                  ),
                }),
            ],
          }),
          jsxs('div', {
            className: 'pm-card',
            children: [
              jsx('h3', { className: 'pm-card-title', children: t('packages.export.title') }),
              jsx('p', { className: 'pm-card-desc', children: t('packages.export.desc') }),
              jsxs('div', {
                className: 'pm-inline',
                children: [
                  jsx('input', {
                    className: 'pm-input',
                    placeholder: t('packages.export.packNamePlaceholder'),
                    value: packName,
                    onChange: (e) => setPackName(e.target.value),
                  }),
                  jsx('button', {
                    type: 'button',
                    className: 'pm-btn pm-btn-primary',
                    disabled: busy !== null,
                    onClick: exportPack,
                    children: busy === 'export' ? t('action.exporting') : t('action.export'),
                  }),
                ],
              }),
              exportableGroups.length > 0
                ? jsxs('div', {
                    className: 'pm-export-box',
                    children: [
                      jsx('button', {
                        type: 'button',
                        className: 'pm-group-head',
                        'aria-expanded': exportOpen,
                        onClick: () => setExportOpen(!exportOpen),
                        children: [
                          jsx('span', {
                            className: 'pm-caret',
                            style: { transform: exportOpen ? 'none' : 'rotate(-90deg)', transition: 'transform .16s' },
                            children: jsx(IconChevronDownOutline14, {}),
                          }),
                          jsx('span', { className: 'pm-group-title', children: t('packages.export.selectGroups', { selected: selectedExportGroups.length, total: exportableGroups.length }) }),
                        ],
                      }),
                      exportOpen
                        ? jsx('div', {
                            className: 'pm-export-list',
                            children: exportableGroups.map((g) =>
                              jsx('label', {
                                key: g.name,
                                className: 'pm-export-row',
                                children: [
                                  jsx('input', {
                                    type: 'checkbox',
                                    checked: exportSelection[g.name] !== false,
                                    onChange: () =>
                                      setExportSelection((s) => ({
                                        ...s,
                                        [g.name]: s[g.name] === false,
                                      })),
                                  }),
                                  jsx('span', { className: 'pm-export-name', title: g.name, children: g.name }),
                                  jsx('span', { className: 'pm-hint', children: t('packages.list.count', { count: g.plugins.length }) }),
                                ],
                              }),
                            ),
                          })
                        : null,
                    ],
                  })
                : null,
            ],
          }),
          msg
            ? jsx('div', {
                className: 'pm-msg' + (msg.isErr ? ' err' : ''),
                children: msg.text,
              })
            : null,
        ],
      })
    }

    function PluginManageSection({ t }) {
      const [tab, setTab] = useState('manage')
      const [data, setData] = useState(null)
      const [msg, setMsg] = useState(null)
      const [busy, setBusy] = useState(null)

      const refresh = useCallback(() => {
        fetchJson('/list')
          .then((d) => {
            if (d && d.ok === false) {
              setMsg({ text: d.error || t('list.failed'), isErr: true })
              return
            }
            setData(d)
          })
          .catch((err) => setMsg({ text: t('load.failed', { error: err }), isErr: true }))
      }, [t])

      useEffect(() => {
        refresh()
        const timer = window.setInterval(refresh, 15000)
        return () => window.clearInterval(timer)
      }, [refresh])

      const onAction = (path, id, label) => {
        setBusy(id + ':' + path)
        setMsg(null)
        fetchJson(path, { method: 'POST', body: JSON.stringify({ id }) })
          .then((r) => {
            if (!r || r.ok === false) {
              setMsg({ text: (r && r.error) || t('op.failed', { label }), isErr: true })
              return
            }
            const result = r.result || {}
            setMsg({ text: result.message || t('install.saved'), isErr: false })
            refresh()
          })
          .catch((err) => setMsg({ text: t('install.requestFailed', { error: err }), isErr: true }))
          .finally(() => setBusy(null))
      }

      const onGroupApply = (name, op) => {
        setBusy(name + ':group:' + op)
        setMsg(null)
        fetchJson('/groups/apply', { method: 'POST', body: JSON.stringify({ name, op }) })
          .then((r) => {
            if (!r || r.ok === false) {
              setMsg({ text: (r && r.error) || t('packages.list.groupFailed'), isErr: true })
              return
            }
            const result = r.result || {}
            setMsg({ text: result.message || t('packages.list.pendingOk'), isErr: false })
            refresh()
          })
          .catch((err) => setMsg({ text: t('install.requestFailed', { error: err }), isErr: true }))
          .finally(() => setBusy(null))
      }

      const onDelegateAi = (taskId) => {
        setBusy('delegate:' + taskId)
        setMsg(null)
        fetchJson('/delegate-ai', { method: 'POST', body: JSON.stringify({ taskId }) })
          .then((r) => {
            if (!r || r.ok === false) {
              setMsg({ text: (r && r.error) || t('install.delegateFailed'), isErr: true })
              return
            }
            const result = r.result || {}
            setMsg({ text: result.message || t('install.delegatedOk'), isErr: false })
          })
          .catch((err) => setMsg({ text: t('install.requestFailed', { error: err }), isErr: true }))
          .finally(() => setBusy(null))
      }

      return jsxs('div', {
        className: 'pm-sec',
        children: [
          jsx('style', {
            'data-plugin-css': 'gamelike-plugin-manage/styles',
            dangerouslySetInnerHTML: { __html: styles },
          }),
          jsx('h2', { className: 'pm-heading', children: t('title') }),
          jsx('div', {
            className: 'pm-tabs',
            role: 'tablist',
            'aria-label': t('title'),
            children: TABS.map((tabDef) =>
              jsx('button', {
                key: tabDef.key,
                type: 'button',
                role: 'tab',
                className: 'pm-tab',
                'aria-selected': tab === tabDef.key,
                'data-active': tab === tabDef.key ? 'true' : undefined,
                tabIndex: tab === tabDef.key ? 0 : -1,
                onClick: () => setTab(tabDef.key),
                children: t(tabDef.label),
              }),
            ),
          }),
          tab === 'manage' ? jsx(ManageTab, { t, data, busy, onAction, onGroupApply }) : null,
          tab === 'download' ? jsx(InstallTab, { t, onRefresh: refresh, onDelegateAi, delegateBusy: busy }) : null,
          tab === 'develop' ? jsx(Placeholder, { t, title: t('develop.title'), desc: t('develop.desc') }) : null,
          tab === 'packages' ? jsx(PackagesTab, { t, data, onRefresh: refresh }) : null,
          msg
            ? jsx('div', {
                className: 'pm-msg' + (msg.isErr ? ' err' : ''),
                children: msg.text,
              })
            : null,
        ],
      })
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      const locale = ctx.get('locale')
      if (slots === undefined || locale === undefined) return
      ctx.effect(() => locale.register(NS, { zh, en }), 'gamelike-plugin-manage: locale dictionaries')
      const t = locale.bind(NS)
      ctx.effect(() => slots.inject('settings.section', () =>
        slots.register({
            name: 'settings.section',
            id: 'gamelike-plugin-manage',
            order: 40,
            label: () => t('nav'),
            locale: NS,
          },
          (props) => jsx(PluginManageSection, props),
        ),
      ), 'gamelike-plugin-manage: settings section')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
