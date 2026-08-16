/**
 * 插件管理服务：只读运行树 + 读/写 profile 持久层 + M2 安装队列。
 * 所有变更操作只写配置文件与 pending 记录，当前进程的 loader 树保持不动。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { ResolvedPaths } from './config.js'
import { scheduleRestart } from './restart.js'
import {
  activatePrepared,
  cleanupExport,
  exportPack,
  prepareLocal,
  prepareSource,
  prepareTgz,
  prepareUpdate,
  resolveInstalledDir,
  type InstallOptions,
  type InstallResult,
  type Prepared,
} from './installer.js'
import { InstallQueue, type InstallTask, type TaskContext } from './tasks.js'
import {
  deleteGroup,
  readGroups,
  upsertGroup,
  type PluginGroup,
} from './groups.js'
import { readVersion } from './store.js'
import {
  messageOf,
  pendingOf,
  prunePending,
  readBundleInsertMap,
  readPatchInsertIds,
  readPending,
  readUserBundles,
  removeBundle,
  removePatchInsert,
  removePending,
  upsertPending,
  writePatchDisabled,
  type ProfileBundle,
} from './profile.js'
import type { ActionOk, DesiredState, ExportPackResult, PluginItem, PluginManageSnapshot, PluginSource } from './types.js'

export interface TaskAccepted {
  taskId: number
  message: string
}

export interface PluginManageService {
  list(): PluginManageSnapshot
  disable(id: string): Promise<ActionOk>
  enable(id: string): Promise<ActionOk>
  uninstall(id: string): Promise<ActionOk>
  /** 撤销一条尚未重启生效的卸载 */
  cancelUninstall(id: string): Promise<ActionOk>
  /** 重启后应用 pending：把待重启操作真正写入 profile 配置 */
  applyPending(): Promise<void>
  /** M1 更新插件（仅 link 目录用户插件；重启后生效） */
  update(id: string): TaskAccepted
  /** M2 安装队列：提交后立即返回任务号 */
  installLocal(path: string, opts?: InstallOptions): TaskAccepted
  installTgz(fileName: string, buffer: Buffer, opts?: InstallOptions): TaskAccepted
  installSource(source: string, opts?: InstallOptions): TaskAccepted
  listTasks(): InstallTask[]
  /** M4 插件分组 */
  listGroups(): PluginGroup[]
  upsertGroup(name: string, desired: PluginGroup['desired'], plugins: string[]): PluginGroup[]
  deleteGroup(name: string): PluginGroup[]
  /** M1 整组启用/禁用：对组内全部用户插件写 pending（重启后生效） */
  applyGroup(name: string, op: 'enable' | 'disable'): Promise<ActionOk>
  /** M4 导出插件包 */
  exportPack(packName: string, groupNames: string[]): Promise<ExportPackResult>
  /** M2/M1 失败任务「交给 AI 配置」：落一份结构化请求文件供 AI 会话读取 */
  delegateAi(taskId: number): Promise<{ method: 'file'; path: string; message: string }>
  /** 调度 DSH 自重启（supervisor 托管时可经 config 禁用） */
  restart(): { pid: number; logOut: string; logErr: string; message: string }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginManage: PluginManageService
  }
}

/** FiberState 数值 → 可读相位（与 dsh-host-plugin-inventory 一致） */
const FIBER_PHASE: Record<number, string | null> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null, // DISPOSED
  5: 'unloading',
}

function classify(
  id: string,
  name: string,
  bundles: ProfileBundle[],
  patchIds: Set<string>,
  bundleInserts: Map<string, string>,
): PluginSource {
  const patchId = patchIdOf(id)
  // 用户 bundle 的 patch 插入行优先：行 name 可能是官方包名（如 archify 插入 skill-filesystem），
  // 但行本身来自用户安装的 bundle → 必须归为用户。
  if (patchIds.has(patchId) || patchIds.has(id)) return 'user'
  if (bundleInserts.has(patchId) || bundleInserts.has(id)) return 'user'
  if (name.startsWith('@deepseek-ai/') || name.startsWith('node:') || name.startsWith('cordis:')) return 'native'
  if (bundles.some((bundle) => bundle.name === name || bundle.name === id || bundle.name === patchId)) return 'user'
  return 'injected'
}

/** include 装配层会把 bundle 行展开成 `include:<原始 id>`；写 patch 要写回原始 id */
function patchIdOf(id: string): string {
  return id.startsWith('include:') ? id.slice('include:'.length) : id
}

function bundleOf(name: string, bundles: ProfileBundle[]): ProfileBundle | undefined {
  return bundles.find((bundle) => bundle.name === name)
}

/**
 * 运行 entry 名 → 真实 bundle 包名。
 * bundle patch 可能用与包名不同的 id/name（如 @tt-a1i/archify-dsh
 * 插入 @deepseek-ai/dsh-skill-filesystem），分组与导出统一使用 bundle 名。
 */
function resolveBundleName(name: string, id: string, bundles: ProfileBundle[], bundleInserts: Map<string, string>): string {
  const patchId = patchIdOf(id)
  const direct = bundles.find((bundle) => bundle.name === name || bundle.name === patchId || bundle.name === id)
  if (direct) return direct.name
  return bundleInserts.get(name) ?? bundleInserts.get(patchId) ?? bundleInserts.get(id) ?? name
}

export interface ServiceOptions {
  /** config.allowRestart：false 时拒绝自重启（supervisor 托管部署） */
  allowRestart: boolean
}

export function createService(ctx: Context, paths: ResolvedPaths, options: ServiceOptions = { allowRestart: true }): PluginManageService {
  const loader: Loader = ctx.loader
  const queue = new InstallQueue()

  function runningById(): Map<string, { enabled: boolean }> {
    const map = new Map<string, { enabled: boolean }>()
    for (const entry of loader.entries()) {
      if (entry.options.group) continue
      map.set(entry.id, { enabled: !entry.disabled })
    }
    return map
  }

  function list(): PluginManageSnapshot {
    const bundles = readUserBundles(paths.packagePath)
    const patchIds = readPatchInsertIds(paths.patchPath)
    const bundleInserts = readBundleInsertMap(paths.packagePath, paths.profileDir)
    let pending = readPending(paths.pendingPath)
    const runningMap = runningById()
    pending = prunePending(paths.pendingPath, pending, new Map([...runningMap].map(([id, v]) => [id, v.enabled])))
    const groups = readGroups(paths.groupsPath)

    const items: PluginItem[] = []
    for (const entry of loader.entries()) {
      if (entry.options.group) continue
      const id = entry.id
      const name = entry.options.name
      const source = classify(id, name, bundles, patchIds, bundleInserts)
      const enabled = !entry.disabled
      const running = {
        id,
        name,
        enabled,
        fiberPhase: entry.fiber === undefined ? null : (FIBER_PHASE[entry.fiber.state] ?? null),
      }
      const change = pendingOf(pending, id)
      let desired: DesiredState = enabled ? 'enabled' : 'disabled'
      if (change) {
        desired = change.op === 'disable' ? 'disabled' : change.op === 'enable' ? 'enabled' : 'removed'
      }
      const bundleName = source === 'user' ? resolveBundleName(name, id, bundles, bundleInserts) : name
      const groupCandidates = source === 'user' ? [name, bundleName, patchIdOf(id)] : [name]
      const pluginGroups = groups
        .filter((group) => group.plugins.some((plugin) => groupCandidates.includes(plugin)))
        .map((group) => group.name)
      let version: string | undefined
      if (source === 'user') {
        const installedDir = resolveInstalledDir(paths, bundleName)
        if (installedDir) version = readVersion(installedDir)
      }
      items.push({
        id,
        name,
        source,
        running,
        desired,
        pending: change !== undefined,
        uninstallable: source !== 'native',
        ephemeral: source === 'injected' ? '临时注入，重启后自动消失；不能持久禁用/卸载' : undefined,
        group: pluginGroups[0],
        groups: pluginGroups,
        version,
      })
    }

    items.sort((a, b) => {
      const rank = (source: PluginSource) => (source === 'native' ? 0 : source === 'user' ? 1 : 2)
      return rank(a.source) - rank(b.source) || a.id.localeCompare(b.id)
    })

    return {
      profile: paths.profile,
      profileDir: paths.profileDir,
      patchPath: paths.patchPath,
      packagePath: paths.packagePath,
      items,
      pending,
      groups,
      restartAllowed: options.allowRestart,
    }
  }

  function requireRunning(id: string): { name: string; source: PluginSource; patchId: string } {
    const entry = [...loader.entries()].find((e) => !e.options.group && e.id === id)
    if (!entry) throw new Error(`运行树中没有插件: ${id}`)
    const bundles = readUserBundles(paths.packagePath)
    const patchIds = readPatchInsertIds(paths.patchPath)
    const bundleInserts = readBundleInsertMap(paths.packagePath, paths.profileDir)
    const source = classify(id, entry.options.name, bundles, patchIds, bundleInserts)
    if (source === 'injected') {
      throw new Error(`"${id}" 是临时注入插件（重启后自动消失），不能持久操作`)
    }
    return { name: entry.options.name, source, patchId: patchIdOf(id) }
  }

  function enqueue(
    kind: 'local' | 'tgz' | 'source',
    label: string,
    opts: InstallOptions,
    prepare: (t: TaskContext, o: InstallOptions) => Prepared | Promise<Prepared>,
  ): TaskAccepted {
    const task = queue.enqueue(kind, label, async (t) => {
      const onStep = (text: string, level?: 'info' | 'ok' | 'warn' | 'error') => t.step(text, level)
      const onProgress = (value: number) => t.progress(value)
      const prepared = await prepare(t, { ...opts, onStep, onProgress })
      return t.finalize(async () => {
        const results = await activatePrepared(ctx, paths, prepared, { onStep, onProgress })
        if (prepared.kind === 'pack' && prepared.pack) {
          applyPackGroups(
            prepared.pack.groups.map((g) => ({
              name: g.name,
              desired: g.desired,
              plugins: g.plugins.map((p) => p.name),
            })),
            onStep,
          )
        }
        return results
      })
    })
    return { taskId: task.id, message: `已加入安装队列 #${task.id}（最多 3 个任务并行，装配阶段自动排队）` }
  }

  /** 插件包安装后恢复分组；并对 desired != as-is 的组写 pending（重启后整组生效） */
  function applyPackGroups(groups: PluginGroup[], onStep: (text: string, level?: 'info' | 'ok' | 'warn' | 'error') => void): void {
    // 只恢复「确实存在」的成员：已装配成功、交集去重跳过、或此前已装。
    // 被 InstallPlan 判定为冲突（版本/内容/entry id）而未装的成员不得成为幽灵分组。
    const installedNames = new Set(readUserBundles(paths.packagePath).map((b) => b.name))
    for (const entry of loader.entries()) {
      if (!entry.options.group) installedNames.add(entry.options.name)
    }
    for (const group of groups) {
      upsertGroup(paths.groupsPath, {
        ...group,
        plugins: group.plugins.filter((name) => installedNames.has(name)),
      })
    }
    const all = readGroups(paths.groupsPath)
    // 多归属下同一插件可能在不同组声明不同 desired：
    // 采用安全向策略 —— disabled 优先（不让「期望启用」覆盖「期望禁用」）。
    const desiredMap = new Map<string, 'enable' | 'disable'>()
    for (const group of all) {
      if (group.desired === 'as-is') continue
      const op = group.desired === 'enabled' ? 'enable' as const : 'disable' as const
      for (const pluginName of group.plugins) {
        const previous = desiredMap.get(pluginName)
        if (previous === undefined || op === 'disable') {
          desiredMap.set(pluginName, op)
        }
      }
    }
    let applied = 0
    for (const [pluginName, op] of desiredMap) {
      const entry = entryByGroupMember(pluginName)
      if (!entry) continue // bundle-only / 尚未进入运行树：重启后由 include 装配
      upsertPending(paths.pendingPath, {
        id: entry.id,
        op,
        ts: Date.now(),
      })
      applied++
    }
    if (applied > 0) {
      onStep(`已恢复分组；已为 ${applied} 个运行中插件写入待重启状态（重启后按组生效；多组 desired 冲突时禁用优先）`, 'ok')
    } else {
      onStep('已恢复分组（组内插件将在重启装配后按 desired 状态生效）', 'ok')
    }
  }

  function userNames(): Set<string> {
    const bundles = readUserBundles(paths.packagePath)
    const patchIds = readPatchInsertIds(paths.patchPath)
    const bundleInserts = readBundleInsertMap(paths.packagePath, paths.profileDir)
    const set = new Set<string>()
    for (const entry of loader.entries()) {
      if (entry.options.group) continue
      if (classify(entry.id, entry.options.name, bundles, patchIds, bundleInserts) === 'user') {
        set.add(resolveBundleName(entry.options.name, entry.id, bundles, bundleInserts))
      }
    }
    return set
  }

  /** 按分组成员名（bundle 包名或旧运行名）查找运行 entry */
  function entryByGroupMember(pluginName: string) {
    const bundles = readUserBundles(paths.packagePath)
    const bundleInserts = readBundleInsertMap(paths.packagePath, paths.profileDir)
    return [...loader.entries()].find((entry) => {
      if (entry.options.group) return false
      if (entry.options.name === pluginName) return true
      return resolveBundleName(entry.options.name, entry.id, bundles, bundleInserts) === pluginName
    })
  }

  return {
    list,

    restart: () => {
      if (!options.allowRestart) {
        throw new Error('此部署已禁用插件自重启（config.allowRestart = false），请由 supervisor 重启 DSH')
      }
      const active = queue.snapshot().some((task) => task.status === 'queued' || task.status === 'running')
      if (active) {
        throw new Error('有安装/更新任务正在运行，请等待完成后再重启 DSH')
      }
      const scheduled = scheduleRestart()
      return {
        ...scheduled,
        message: `已调度 DSH 自重启（0.5s 后退出当前进程，1.5s 后拉起新进程）。重启日志：${scheduled.logOut} / ${scheduled.logErr}`,
      }
    },

    async disable(id: string): Promise<ActionOk> {
      const { source } = requireRunning(id)
      const pending = upsertPending(paths.pendingPath, { id, op: 'disable', ts: Date.now() })
      return {
        id,
        op: 'disable',
        message: `已记录待重启操作：禁用「${id}」（来源: ${source}）。当前运行不变，重启 DSH 后生效；再次重启前可随时取消。待重启项共 ${pending.length} 条。`,
      }
    },

    async enable(id: string): Promise<ActionOk> {
      const { source } = requireRunning(id)
      const pending = upsertPending(paths.pendingPath, { id, op: 'enable', ts: Date.now() })
      return {
        id,
        op: 'enable',
        message: `已记录待重启操作：启用「${id}」（来源: ${source}）。当前运行不变，重启 DSH 后生效。待重启项共 ${pending.length} 条。`,
      }
    },

    async uninstall(id: string): Promise<ActionOk> {
      const { name, source } = requireRunning(id)
      if (source === 'native') throw new Error(`"${id}" 是原生插件，不允许卸载（只能禁用）`)
      const pending = upsertPending(paths.pendingPath, { id, op: 'uninstall', ts: Date.now() })
      return {
        id,
        op: 'uninstall',
        message: `已记录待重启操作：卸载「${id}」（${name}）。当前运行不变，重启 DSH 后生效；未重启前可在列表里「取消卸载」。待重启项共 ${pending.length} 条。`,
      }
    },

    async cancelUninstall(id: string): Promise<ActionOk> {
      if (!runningById().has(id)) {
        throw new Error(`"${id}" 已在重启后卸载，无法取消`)
      }
      const change = readPending(paths.pendingPath).find((c) => c.id === id && c.op === 'uninstall')
      if (!change) throw new Error(`没有「${id}」的待重启卸载记录`)
      const pending = removePending(paths.pendingPath, id)
      return {
        id,
        op: 'uninstall',
        message: `已取消卸载「${id}」：配置从未改动，重启后仍在。待重启项共 ${pending.length} 条。`,
      }
    },

    async applyPending(): Promise<void> {
      const pending = readPending(paths.pendingPath)
      if (!pending.length) return
      for (const change of pending) {
        try {
          const entry = [...loader.entries()].find((e) => !e.options.group && e.id === change.id)
          if (!entry) continue
          const patchId = patchIdOf(change.id)
          const name = entry.options.name
          const bundles = readUserBundles(paths.packagePath)
          const patchIds = readPatchInsertIds(paths.patchPath)
          const bundleInserts = readBundleInsertMap(paths.packagePath, paths.profileDir)
          const source = classify(change.id, name, bundles, patchIds, bundleInserts)
          if (change.op === 'update') {
            // 更新已在任务执行时完成（git pull / 重新构建），重启后即生效；
            // 这里无需写配置，该条 pending 会被 prune 在重启后清理。
            continue
          }
          if (change.op === 'disable') {
            writePatchDisabled(paths.patchPath, patchId, true)
          } else if (change.op === 'enable') {
            writePatchDisabled(paths.patchPath, patchId, false)
          } else if (change.op === 'uninstall') {
            if (source === 'native') continue
            let done = false
            const insertBundle = bundleInserts.get(patchId) || bundleInserts.get(change.id)
            if (insertBundle) {
              done = removeBundle(paths.packagePath, insertBundle) || done
              writePatchDisabled(paths.patchPath, patchId, true)
            }
            const bundle = bundleOf(name, bundles)
            if (bundle) {
              done = removeBundle(paths.packagePath, bundle.name) || done
              writePatchDisabled(paths.patchPath, patchId, true)
            }
            if (patchIds.has(patchId) || patchIds.has(change.id)) {
              done = removePatchInsert(paths.patchPath, patchId) || removePatchInsert(paths.patchPath, change.id) || done
            }
            if (!done) throw new Error(`pending uninstall ${change.id}: 无法定位持久装配记录`)
          }
        } catch (error) {
          ;(ctx as unknown as { logger?: (name: string) => { error?(msg: string): void } })
            .logger?.('plugin-manage')?.error?.('pending apply 失败: ' + change.id + ' ' + messageOf(error))
        }
      }
    },

    update: (id: string): TaskAccepted => {
      const { name, source } = requireRunning(id)
      if (source !== 'user') {
        throw new Error(`「${name}」不是用户插件，暂不支持更新（原生/临时注入只读）`)
      }
      const task = queue.enqueue('update', `更新 ${name}`, async (t) => {
        const onStep = (text: string, level?: 'info' | 'ok' | 'warn' | 'error') => t.step(text, level)
        const onProgress = (value: number) => t.progress(value)
        prepareUpdate(paths, name, { onStep, onProgress })
        return t.finalize(async () => {
          upsertPending(paths.pendingPath, { id, op: 'update', ts: Date.now() })
          onProgress(100)
          onStep(`更新完成：${name}（重启 DSH 后生效）`, 'ok')
          return []
        })
      })
      return { taskId: task.id, message: `已加入更新队列 #${task.id}（准备阶段并行，最多 3 路）。更新完成后重启 DSH 生效。` }
    },

    installLocal: (path: string, opts: InstallOptions = {}) =>
      enqueue('local', `本地目录 ${path}`, opts, (t, o) => Promise.resolve(prepareLocal(paths, path, o))),

    installTgz: (fileName: string, buffer: Buffer, opts: InstallOptions = {}) =>
      enqueue('tgz', `上传包 ${fileName}`, opts, (t, o) => prepareTgz(paths, fileName, buffer, o)),

    installSource: (source: string, opts: InstallOptions = {}) =>
      enqueue('source', source, opts, (t, o) => prepareSource(paths, source, o)),

    listTasks: () => queue.snapshot(),

    listGroups: () => readGroups(paths.groupsPath),

    upsertGroup: (name: string, desired: PluginGroup['desired'], plugins: string[]): PluginGroup[] => {
      const clean = name.trim()
      if (!clean) throw new Error('分组名必填')
      const users = userNames()
      const bundleInserts = readBundleInsertMap(paths.packagePath, paths.profileDir)
      const valid: string[] = []
      for (const pluginName of plugins) {
        if (users.has(pluginName)) {
          valid.push(pluginName)
          continue
        }
        // 兼容旧数据：分组里可能存的是运行 entry 名（如 @deepseek-ai/dsh-skill-filesystem），
        // 反查真实 bundle 名（@tt-a1i/archify-dsh）后迁移。
        const owner = bundleInserts.get(pluginName)
        if (owner && users.has(owner)) valid.push(owner)
      }
      if (valid.length === 0) throw new Error('分组里没有可用的用户插件')
      return upsertGroup(paths.groupsPath, { name: clean, desired, plugins: valid })
    },

    deleteGroup: (name: string): PluginGroup[] => deleteGroup(paths.groupsPath, name),

    async applyGroup(name: string, op: 'enable' | 'disable'): Promise<ActionOk> {
      const groups = readGroups(paths.groupsPath)
      const group = groups.find((g) => g.name === name)
      if (!group) throw new Error(`没有分组: ${name}`)
      if (group.plugins.length === 0) throw new Error(`分组「${name}」没有插件`)
      const users = userNames()
      let count = 0
      for (const pluginName of group.plugins) {
        if (!users.has(pluginName)) continue
        const entry = entryByGroupMember(pluginName)
        if (!entry) continue
        upsertPending(paths.pendingPath, { id: entry.id, op, ts: Date.now() })
        count++
      }
      if (count === 0) throw new Error(`分组「${name}」没有可操作的用户插件（可能尚未装配）`)
      return {
        id: name,
        op,
        message: `已记录待重启操作：${op === 'enable' ? '启用' : '禁用'}分组「${name}」的 ${count} 个插件。当前运行不变，重启 DSH 后生效。`,
      }
    },

    async exportPack(packName: string, groupNames: string[]): Promise<ExportPackResult> {
      const all = readGroups(paths.groupsPath)
      const selected = groupNames.length > 0 ? all.filter((g) => groupNames.includes(g.name)) : all
      return exportPack(paths, selected, packName.trim() || 'dsh-plugin-pack')
    },

    async delegateAi(taskId: number): Promise<{ method: 'file'; path: string; message: string }> {
      const tasks = queue.snapshot()
      const task = tasks.find((t) => t.id === taskId)
      if (!task) throw new Error(`没有任务 #${taskId}`)
      const request = {
        createdAt: new Date().toISOString(),
        type: 'plugin-manage.ai-config-request',
        version: 1,
        task: {
          id: task.id,
          kind: task.kind,
          label: task.label,
          status: task.status,
          error: task.error,
          progress: task.progress,
          steps: task.steps,
          result: task.result,
        },
        instructions:
          '这是 DSH 插件管理（gamelike-plugin-manage）的失败任务。「交给 AI 配置」按钮由用户点击。' +
          '请阅读 task 中的错误与步骤，定位失败原因并直接修复配置/代码，或给出用户可执行的修复方案。',
      }
      mkdirSync(dirname(paths.aiRequestPath), { recursive: true })
      writeFileSync(paths.aiRequestPath, JSON.stringify(request, null, 2) + '\n')
      return {
        method: 'file',
        path: paths.aiRequestPath,
        message: `已生成 AI 配置请求：${paths.aiRequestPath}。请让 AI 会话读取该文件继续处理（或直接把该文件内容贴给 AI）。`,
      }
    },
  }
}

export { messageOf }
