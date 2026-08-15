// gamelike-plugin-manage browser half：设置页「插件管理」区段（settings.section）。
// 依据官方 skill cordis-plugin-development「Settings pages」：
//   完整设置 UI 注册自己的 settings.section。
// 注册模式：ctx.get('slots') → slots.inject(name, () => slots.register({ name, id, order, label }, component))。
// M1：搜索 + 两组折叠（原生 / 用户）；操作只写 profile 配置，重启后生效。
// 样式用设计令牌；host↔client 用 webServer HTTP 桥；零构建，build:client 原样复制为 lib/client.js。
window.__ModuleLoader__.load({
  id: 'gamelike-plugin-manage',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { useState, useCallback, useEffect } = React
    const { jsx, jsxs } = require('react/jsx-runtime')

    const inject = ['slots']

    const API = '/plugin-manage/api'

    const styles = `
.pm-sec{max-width:860px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.pm-heading{margin:0;font-size:18px;font-weight:600}
.pm-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:1.5}
.pm-tabs{display:flex;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:0}
.pm-tab{appearance:none;font:inherit;cursor:pointer;border:0;background:0 0;padding:7px 14px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);border-bottom:2px solid transparent;margin-bottom:-1px}
.pm-tab:hover{color:var(--dsw-alias-label-primary)}
.pm-tab.on{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.pm-badges{align-items:center;gap:8px;display:flex;flex-wrap:wrap}
.pm-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.pm-badge.native{color:#4da3ff}
.pm-badge.user{color:#2ecc71}
.pm-badge.inj{color:#f1c40f}
.pm-badge.warn{color:#f1c40f}
.pm-search{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);min-height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:13px;line-height:1.5}
.pm-search:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.pm-group{margin:0;padding:0}
.pm-group-head{appearance:none;font:inherit;cursor:pointer;border:0;background:0 0;width:100%;display:flex;align-items:center;gap:8px;padding:8px 0;color:var(--dsw-alias-label-primary);text-align:left}
.pm-group-head:hover .pm-group-title{color:var(--dsw-alias-brand-primary)}
.pm-caret{display:inline-block;width:12px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.pm-group-title{font-size:13px;font-weight:600;line-height:1.5}
.pm-group-count{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.pm-list{list-style:none;margin:0;padding:0 0 0 20px}
.pm-row{flex-direction:column;gap:6px;padding:10px 0;display:flex}
.pm-row + .pm-row{border-top:1px solid var(--dsw-alias-border-l2)}
.pm-row-head{align-items:center;gap:8px;display:flex}
.pm-id{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-mod{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace}
.pm-real{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;font-family:monospace}
.pm-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.pm-st{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.pm-st.active{color:#2ecc71}
.pm-st.failed{color:var(--dsw-alias-label-error)}
.pm-st.off{color:var(--dsw-alias-label-tertiary)}
.pm-st.pending{color:#f1c40f}
.pm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 12px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:0 0;white-space:nowrap}
.pm-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.pm-btn-danger{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error)}
.pm-btn:disabled{opacity:.4;cursor:default}
.pm-msg{margin-top:4px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);white-space:pre-wrap;max-height:180px;overflow:auto;font-size:12px;line-height:1.5}
.pm-msg.err{border-color:var(--dsw-alias-label-error)}
.pm-empty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;padding:12px 0;text-align:left}
.pm-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:0}
.pm-placeholder{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:36px 20px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.pm-placeholder b{display:block;color:var(--dsw-alias-label-secondary);font-size:15px;margin-bottom:6px}
.pm-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.pm-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.pm-card-desc{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0;line-height:1.5}
.pm-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);min-height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:13px;line-height:1.5}
.pm-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.pm-inline{display:flex;gap:8px;align-items:center}
.pm-inline .pm-input{flex:1}
.pm-drop{border:1.5px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:22px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;transition:border-color .15s,color .15s,background .15s;cursor:pointer}
.pm-drop.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-3)}
.pm-drop b{display:block;font-size:14px;margin-bottom:4px;font-weight:600}
.pm-feed{display:flex;flex-direction:column;gap:3px;max-height:126px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);padding:6px 10px}
.pm-feed::-webkit-scrollbar{width:8px}
.pm-feed::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px}
.pm-feed-item{display:flex;flex-direction:column;gap:3px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);font-family:monospace;animation:pm-pop .22s ease-out}
.pm-feed-line{display:flex;align-items:baseline;gap:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-feed-item.error .pm-feed-line{white-space:normal;overflow:visible;flex-wrap:wrap;align-items:flex-start}
.pm-error-full{border:1px solid var(--dsw-alias-label-error);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.pm-error-full b{font-size:12px;color:var(--dsw-alias-label-error);font-weight:600}
.pm-error-full pre{margin:0;white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.pm-feed-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
.pm-feed-item.error .pm-feed-text{white-space:pre-wrap;word-break:break-all;overflow:visible;flex:1 1 100%}
.pm-feed-pct{margin-left:auto;flex:0 0 auto;font-weight:600;color:var(--dsw-alias-label-secondary);font-size:10px}
.pm-bar-track{height:3px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden}
.pm-bar{height:100%;width:0;border-radius:2px;background:var(--dsw-alias-brand-primary);transition:width .25s ease}
.pm-bar.success{background:#2ecc71}
.pm-bar.failed{background:var(--dsw-alias-label-error)}
.pm-bar.queued{background:#f1c40f}
.pm-feed-item b{font-weight:600;color:var(--dsw-alias-label-secondary);flex:0 0 auto}
.pm-feed-item.ok{color:#2ecc71}
.pm-feed-item.warn{color:#f1c40f}
.pm-feed-item.error{color:var(--dsw-alias-label-error)}
.pm-feed-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;align-self:center;background:var(--dsw-alias-label-tertiary)}
.pm-feed-dot.queued{background:#f1c40f}
.pm-feed-dot.running{background:var(--dsw-alias-brand-primary);animation:pm-pulse 1s infinite alternate}
.pm-feed-dot.success{background:#2ecc71}
.pm-feed-dot.failed{background:var(--dsw-alias-label-error)}
@keyframes pm-pulse{from{opacity:.35}to{opacity:1}}
@keyframes pm-pop{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:translateY(0)}}
`

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

    function phaseLabel(phase, enabled) {
      if (!enabled) return { text: '已禁用', cls: 'off' }
      if (phase === 'active') return { text: '运行中', cls: 'active' }
      if (phase === 'failed') return { text: '失败', cls: 'failed' }
      if (phase === 'pending' || phase === 'loading' || phase === 'unloading') return { text: phase, cls: 'pending' }
      return { text: '未加载', cls: 'off' }
    }

    const TABS = [
      { key: 'manage', label: '管理插件' },
      { key: 'download', label: '插件安装' },
      { key: 'develop', label: '开发插件' },
      { key: 'packages', label: '插件包' },
    ]

    function Placeholder({ title, desc }) {
      return jsx('div', {
        className: 'pm-placeholder',
        children: [
          jsx('b', { children: title }),
          jsx('span', { children: desc || '该模块尚未开放，将在后续版本提供。' }),
        ],
      })
    }

    function sourceBadge(source) {
      if (source === 'native') return jsx('span', { className: 'pm-badge native', children: '原生' })
      if (source === 'user') return jsx('span', { className: 'pm-badge user', children: '用户' })
      return jsx('span', { className: 'pm-badge inj', children: '临时注入' })
    }

    function pendingText(item) {
      if (!item.pending) return null
      const text = item.desired === 'removed' ? '待重启卸载' : item.desired === 'disabled' ? '待重启禁用' : '待重启启用'
      return jsx('span', { className: 'pm-st pending', children: text })
    }

    function PluginRow({ item, busy, onAction }) {
      const ph = phaseLabel(item.running.fiberPhase, item.running.enabled)
      const showUninstall = item.source === 'user' && !(item.pending && item.desired === 'removed')
      const canToggle = item.source !== 'injected' && !(item.pending && item.desired === 'removed')
      const showCancelUninstall = item.source === 'user' && item.pending && item.desired === 'removed'
      const toggleLabel = item.desired === 'disabled' ? '启用' : '禁用'
      const togglePath = item.desired === 'disabled' ? '/enable' : '/disable'
      return jsx('li', {
        className: 'pm-row',
        children: [
          jsx('div', {
            className: 'pm-row-head',
            children: [
              jsx('span', { className: 'pm-id', children: displayId(item) }),
              sourceBadge(item.source),
              jsx('span', { className: 'pm-st ' + ph.cls, children: ph.text }),
              pendingText(item),
            ],
          }),
          jsx('div', { className: 'pm-mod', children: item.name + (realId(item) ? ' · 实际 id: ' + realId(item) : '') }),
          item.ephemeral ? jsx('p', { className: 'pm-hint', children: item.ephemeral }) : null,
          jsx('div', {
            className: 'pm-actions',
            children: [
              canToggle
                ? jsx('button', {
                    className: 'pm-btn',
                    disabled: busy !== null,
                    onClick: () => onAction(togglePath, item.id, toggleLabel),
                    children: toggleLabel,
                  })
                : null,
              showUninstall
                ? jsx('button', {
                    className: 'pm-btn pm-btn-danger',
                    disabled: busy !== null,
                    onClick: () => {
                      if (window.confirm('确定卸载「' + displayId(item) + '」？配置会在重启 DSH 后生效。')) {
                        onAction('/uninstall', item.id, '卸载')
                      }
                    },
                    children: '卸载',
                  })
                : null,
              showCancelUninstall
                ? jsx('button', {
                    className: 'pm-btn',
                    disabled: busy !== null,
                    onClick: () => onAction('/cancel-uninstall', item.id, '取消卸载'),
                    children: '取消卸载',
                  })
                : null,
              item.source === 'injected' ? jsx('span', { className: 'pm-hint', children: '只读' }) : null,
            ],
          }),
        ],
      })
    }



    /** 紧凑实时信息流（只放进行中/刚完成）；失败任务用下方完整错误面板显示 */
    function TasksPanel({ tasks }) {
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

      const clock = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
      const textOf = (task, step) => {
        if (task.status === 'success') return step ? step.text : '完成'
        if (task.status === 'queued') return '排队中 · ' + task.label
        return step ? step.text : '准备中…'
      }
      const levelOf = (task, step) => {
        if (task.status === 'success') return 'ok'
        if (step && step.level !== 'info') return step.level
        return ''
      }

      const feed = rows.length
        ? jsx('div', {
            className: 'pm-feed',
            children: rows.map(({ task, step }) =>
              jsx('div', {
                key: task.id,
                className: 'pm-feed-item ' + levelOf(task, step),
                children: [
                  jsx('div', {
                    className: 'pm-feed-line',
                    children: [
                      jsx('span', { className: 'pm-feed-dot ' + task.status }),
                      jsx('b', { children: '#' + task.id }),
                      jsx('span', { children: clock(step ? step.ts : task.createdAt) }),
                      jsx('span', { className: 'pm-feed-text', children: textOf(task, step) }),
                      jsx('span', { className: 'pm-feed-pct', children: task.progress + '%' }),
                    ],
                  }),
                  jsx('div', {
                    className: 'pm-bar-track',
                    children: jsx('div', {
                      className: 'pm-bar ' + task.status,
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
              jsx('b', { children: '#' + failed[0].id + ' 安装失败 · ' + failed[0].label }),
              jsx('pre', { children: failed[0].error || '未知错误' }),
            ],
          })
        : null

      if (!feed && !errorPanel) return null
      return jsxs('div', { children: [errorPanel, feed] })
    }

    function InstallTab({ onRefresh }) {
      const [dir, setDir] = useState('')
      const [source, setSource] = useState('')
      const [dragging, setDragging] = useState(false)
      const [busy, setBusy] = useState(null)
      const [msg, setMsg] = useState(null)
      const [buildOk, setBuildOk] = useState(false)
      const [tasks, setTasks] = useState([])

      const pollTasks = useCallback(() => {
        fetchJson('/install-tasks')
          .then((r) => {
            if (r && r.ok !== false) setTasks(r.tasks || [])
          })
          .catch(() => {})
      }, [])

      useEffect(() => {
        pollTasks()
        const timer = window.setInterval(pollTasks, 800)
        return () => window.clearInterval(timer)
      }, [pollTasks])

      const finish = (r, okText) => {
        if (!r || r.ok === false) {
          setMsg({ text: (r && r.error) || '提交失败', isErr: true })
          return false
        }
        setMsg({ text: (r.result && r.result.message) || okText, isErr: false })
        pollTasks()
        if (onRefresh) onRefresh()
        return true
      }

      const installLocal = () => {
        if (!dir.trim()) {
          setMsg({ text: '请填写插件目录路径', isErr: true })
          return
        }
        setBusy('local')
        setMsg(null)
        fetchJson('/install-local', { method: 'POST', body: JSON.stringify({ path: dir.trim(), allowBuild: buildOk }) })
          .then((r) => finish(r, '安装成功'))
          .catch((err) => setMsg({ text: '请求失败: ' + err, isErr: true }))
          .finally(() => setBusy(null))
      }

      const installSource = () => {
        if (!source.trim()) {
          setMsg({ text: '请填写 GitHub 地址或 npm 包名/安装指令', isErr: true })
          return
        }
        setBusy('source')
        setMsg(null)
        fetchJson('/install-source', { method: 'POST', body: JSON.stringify({ source: source.trim(), allowBuild: buildOk }) })
          .then((r) => finish(r, '安装成功'))
          .catch((err) => setMsg({ text: '请求失败: ' + err, isErr: true }))
          .finally(() => setBusy(null))
      }

      const uploadFile = (file) => {
        if (!file) return
        if (!/\.(tgz|tar\.gz)$/i.test(file.name)) {
          setMsg({ text: '仅支持 .tgz / .tar.gz 压缩包', isErr: true })
          return
        }
        setBusy('drop')
        setMsg({ text: '正在上传并安装 ' + file.name + ' …', isErr: false })
        fetch(API + '/install-tgz', {
          method: 'POST',
          headers: { 'x-file-name': encodeURIComponent(file.name), 'x-allow-build': buildOk ? 'true' : 'false' },
          body: file,
        })
          .then((r) => r.json())
          .then((r) => finish(r, '安装成功'))
          .catch((err) => setMsg({ text: '上传失败: ' + err, isErr: true }))
          .finally(() => setBusy(null))
      }

      return jsxs('div', {
        children: [
          jsx('p', {
            className: 'pm-intro',
            children: '三种安装方式，任选其一：本地目录 / 拖入 .tgz 压缩包 / GitHub 地址或 npm 指令。安装后立即生效，并写入 profile 持久化（重启仍在）。',
          }),
          jsx('label', {
            className: 'pm-hint',
            style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' },
            children: [
              jsx('input', {
                type: 'checkbox',
                checked: buildOk,
                onChange: (e) => setBuildOk(e.target.checked),
              }),
              jsx('span', { children: '允许执行构建脚本（仅对缺少 lib/ 的包生效；会执行该来源的 npm install / 构建脚本，请确认来源可信）' }),
            ],
          }),
          jsx(TasksPanel, { tasks }),
          jsxs('div', {
            className: 'pm-card',
            children: [
              jsx('h3', { className: 'pm-card-title', children: '① 本地目录' }),
              jsx('p', { className: 'pm-card-desc', children: '填写插件项目目录（含 package.json 与 lib/，支持 Windows 或 WSL 路径），未构建会自动尝试构建。' }),
              jsx('div', {
                className: 'pm-inline',
                children: [
                  jsx('input', {
                    className: 'pm-input',
                    placeholder: '例如 C:\\Users\\Administrator\\my-plugin 或 /mnt/c/...',
                    value: dir,
                    onChange: (e) => setDir(e.target.value),
                  }),
                  jsx('button', {
                    className: 'pm-btn',
                    disabled: busy !== null,
                    onClick: installLocal,
                    children: busy === 'local' ? '安装中…' : '安装',
                  }),
                ],
              }),
            ],
          }),
          jsxs('div', {
            className: 'pm-card',
            children: [
              jsx('h3', { className: 'pm-card-title', children: '② 拖拽压缩包' }),
              jsx('p', { className: 'pm-card-desc', children: '把 .tgz / .tar.gz 插件包拖进下面区域，松手即自动上传安装。' }),
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
                  jsx('b', { children: dragging ? '松开立即安装' : '拖拽 .tgz 到这里' }),
                  jsx('span', { children: busy === 'drop' ? '正在安装，请稍候…' : '松手即自动安装，无需点击按钮' }),
                ],
              }),
            ],
          }),
          jsxs('div', {
            className: 'pm-card',
            children: [
              jsx('h3', { className: 'pm-card-title', children: '③ GitHub 地址 / npm 指令' }),
              jsx('p', { className: 'pm-card-desc', children: 'GitHub 仓库会自动 clone + 构建；npm 会执行 npm pack 后安装。二者共用一个输入框，自动识别。' }),
              jsx('div', {
                className: 'pm-inline',
                children: [
                  jsx('input', {
                    className: 'pm-input',
                    placeholder: 'https://github.com/user/repo 或 npm install some-package',
                    value: source,
                    onChange: (e) => setSource(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') installSource()
                    },
                  }),
                  jsx('button', {
                    className: 'pm-btn',
                    disabled: busy !== null,
                    onClick: installSource,
                    children: busy === 'source' ? '安装中…' : '安装',
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


    function ManageTab({ data, busy, onAction }) {
      const [search, setSearch] = useState('')
      const [collapsed, setCollapsed] = useState({ native: false, user: false })
      const items = (data && data.items) || []
      const nativeAll = items.filter((i) => i.source === 'native')
      const userAll = items.filter((i) => i.source !== 'native') // user + injected 归入「用户」组
      const pendingCount = items.filter((i) => i.pending).length

      const q = search.trim().toLowerCase()
      const match = (i) => !q || displayId(i).toLowerCase().includes(q) || i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q)
      const nativeItems = nativeAll.filter(match)
      const userItems = userAll.filter(match)
      const searching = q.length > 0

      const group = (key, title, all, filtered) => {
        const isCollapsed = collapsed[key]
        const count = searching ? `匹配 ${filtered.length} / 共 ${all.length}` : `${all.length} 个`
        return jsxs('div', {
          className: 'pm-group',
          children: [
            jsx('button', {
              className: 'pm-group-head',
              onClick: () => setCollapsed((c) => ({ ...c, [key]: !c[key] })),
              children: [
                jsx('span', { className: 'pm-caret', children: isCollapsed ? '▸' : '▾' }),
                jsx('span', { className: 'pm-group-title', children: title }),
                jsx('span', { className: 'pm-group-count', children: count }),
              ],
            }),
            isCollapsed
              ? null
              : filtered.length === 0
                ? jsx('p', { className: 'pm-empty', children: searching ? '（无匹配）' : '（空）' })
                : jsx('ul', {
                    className: 'pm-list',
                    children: filtered.map((item) => jsx(PluginRow, { key: item.id, item, busy, onAction })),
                  }),
          ],
        })
      }

      return jsxs('div', {
        children: [
          jsx('p', {
            className: 'pm-intro',
            children: '操作只写入 profile 配置（cordis.patch.yml / package.json），当前进程不动，重启 DSH 后生效；原生插件不可卸载。',
          }),
          jsx('div', {
            className: 'pm-badges',
            children: [
              jsx('span', { className: 'pm-badge native', children: '原生 ' + nativeAll.length }),
              jsx('span', { className: 'pm-badge user', children: '用户 ' + userAll.length }),
              pendingCount > 0 ? jsx('span', { className: 'pm-badge warn', children: '待重启 ' + pendingCount }) : null,
            ],
          }),
          jsx('input', {
            className: 'pm-search',
            placeholder: '搜索插件 id / 包名…',
            value: search,
            onChange: (e) => setSearch(e.target.value),
          }),
          items.length === 0
            ? jsx('p', { className: 'pm-empty', children: '（没有读取到任何插件）' })
            : jsxs('div', {
                children: [
                  group('native', '原生', nativeAll, nativeItems),
                  group('user', '用户', userAll, userItems),
                ],
              }),
          jsx('p', { className: 'pm-hint', children: data ? '配置位置：' + data.patchPath + ' · 刷新间隔 15s' : '' }),
        ],
      })
    }

    function PluginManageSection() {
      const [tab, setTab] = useState('manage')
      const [data, setData] = useState(null)
      const [msg, setMsg] = useState(null)
      const [busy, setBusy] = useState(null)

      const refresh = useCallback(() => {
        fetchJson('/list')
          .then((d) => {
            if (d && d.ok === false) {
              setMsg({ text: d.error || 'list 失败', isErr: true })
              return
            }
            setData(d)
          })
          .catch((err) => setMsg({ text: '加载失败: ' + err, isErr: true }))
      }, [])

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
              setMsg({ text: (r && r.error) || label + ' 失败', isErr: true })
              return
            }
            const result = r.result || {}
            setMsg({ text: result.message || '已写入配置，重启 DSH 后生效', isErr: false })
            refresh()
          })
          .catch((err) => setMsg({ text: '请求失败: ' + err, isErr: true }))
          .finally(() => setBusy(null))
      }

      return jsxs('div', {
        className: 'pm-sec',
        children: [
          jsx('style', { dangerouslySetInnerHTML: { __html: styles } }),
          jsx('h2', { className: 'pm-heading', children: '插件管理' }),
          jsx('div', {
            className: 'pm-tabs',
            children: TABS.map((t) =>
              jsx('button', {
                key: t.key,
                className: 'pm-tab' + (tab === t.key ? ' on' : ''),
                onClick: () => setTab(t.key),
                children: t.label,
              }),
            ),
          }),
          tab === 'manage' ? jsx(ManageTab, { data, busy, onAction }) : null,
          tab === 'download' ? jsx(InstallTab, { onRefresh: refresh }) : null,
          tab === 'develop' ? jsx(Placeholder, { title: '开发插件', desc: '生成插件骨架、构建、注入调试 —— 暂未开放。' }) : null,
          tab === 'packages' ? jsx(Placeholder, { title: '插件包', desc: '本地插件包（.tgz）管理 —— 暂未开放。' }) : null,
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
      // 官方 skill：ctx.get('slots') + slots.inject + register(options, component)
      const slots = ctx.get('slots')
      if (slots === undefined) return
      ctx.effect(() => slots.inject('settings.section', () =>
        slots.register({
            name: 'settings.section',
            id: 'gamelike-plugin-manage',
            order: 40,
            label: () => '插件管理',
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
