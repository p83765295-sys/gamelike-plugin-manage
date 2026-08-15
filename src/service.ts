/**
 * 插件管理服务：只读运行树 + 读/写 profile 持久层。
 * 所有变更操作只写配置文件与 pending 记录，当前进程的 loader 树保持不动。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { ResolvedPaths } from './config.js'
import {
  messageOf,
  pendingOf,
  prunePending,
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
import type { ActionOk, DesiredState, PluginItem, PluginManageSnapshot, PluginSource } from './types.js'

export interface PluginManageService {
  list(): PluginManageSnapshot
  disable(id: string): Promise<ActionOk>
  enable(id: string): Promise<ActionOk>
  uninstall(id: string): Promise<ActionOk>
  /** 撤销一条尚未重启生效的卸载 */
  cancelUninstall(id: string): Promise<ActionOk>
  /** 重启后应用 pending：把待重启操作真正写入 profile 配置 */
  applyPending(): Promise<void>
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

function classify(id: string, name: string, bundles: ProfileBundle[], patchIds: Set<string>): PluginSource {
  const patchId = patchIdOf(id)
  // 原生包名前缀优先：profile bundles 里的 @deepseek-ai/dsh-base / dsh-web-app 是原生底座，
  // 其展开行（include:web-runtime 等）不能因为「bundles 列表里有它」被判成用户插件。
  if (name.startsWith('@deepseek-ai/') || name.startsWith('node:') || name.startsWith('cordis:')) return 'native'
  if (patchIds.has(patchId) || patchIds.has(id)) return 'user'
  if (bundles.some((bundle) => bundle.name === name)) return 'user'
  // 裸包名 / 绝对路径 / @dsh-external 等，未登记在持久层 → 临时注入
  return 'injected'
}

/** include 装配层会把 bundle 行展开成 `include:<原始 id>`；写 patch 要写回原始 id */
function patchIdOf(id: string): string {
  return id.startsWith('include:') ? id.slice('include:'.length) : id
}

function bundleOf(name: string, bundles: ProfileBundle[]): ProfileBundle | undefined {
  return bundles.find((bundle) => bundle.name === name)
}

export function createService(ctx: Context, paths: ResolvedPaths): PluginManageService {
  const loader: Loader = ctx.loader

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
    let pending = readPending(paths.pendingPath)

    // 先清掉重启后已经生效的历史 pending
    const runningMap = runningById()
    pending = prunePending(paths.pendingPath, pending, new Map([...runningMap].map(([id, v]) => [id, v.enabled])))

    const items: PluginItem[] = []
    for (const entry of loader.entries()) {
      if (entry.options.group) continue
      const id = entry.id
      const name = entry.options.name
      const source = classify(id, name, bundles, patchIds)
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
      items.push({
        id,
        name,
        source,
        running,
        desired,
        pending: change !== undefined,
        uninstallable: source !== 'native',
        ephemeral: source === 'injected' ? '临时注入，重启后自动消失；不能持久禁用/卸载' : undefined,
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
    }
  }

  function requireRunning(id: string): { name: string; source: PluginSource; patchId: string } {
    const entry = [...loader.entries()].find((e) => !e.options.group && e.id === id)
    if (!entry) throw new Error(`运行树中没有插件: ${id}`)
    const bundles = readUserBundles(paths.packagePath)
    const patchIds = readPatchInsertIds(paths.patchPath)
    const source = classify(id, entry.options.name, bundles, patchIds)
    if (source === 'injected') {
      throw new Error(`"${id}" 是临时注入插件（重启后自动消失），不能持久操作`)
    }
    return { name: entry.options.name, source, patchId: patchIdOf(id) }
  }

  return {
    list,

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
          if (!entry) continue // 该行已不在运行树（例如上次重启已卸载）→ 交给 prune 清理
          const patchId = patchIdOf(change.id)
          const name = entry.options.name
          const bundles = readUserBundles(paths.packagePath)
          const patchIds = readPatchInsertIds(paths.patchPath)
          const source = classify(change.id, name, bundles, patchIds)
          if (change.op === 'disable') {
            writePatchDisabled(paths.patchPath, patchId, true)
          } else if (change.op === 'enable') {
            writePatchDisabled(paths.patchPath, patchId, false)
          } else if (change.op === 'uninstall') {
            if (source === 'native') continue // 边界：重启后来源变化，跳过危险卸载
            let done = false
            const bundle = bundleOf(name, bundles)
            if (bundle) {
              done = removeBundle(paths.packagePath, bundle.name) || done
              writePatchDisabled(paths.patchPath, patchId, true)
            }
            if (patchIds.has(patchId) || patchIds.has(change.id)) {
              done = removePatchInsert(paths.patchPath, patchId) || removePatchInsert(paths.patchPath, change.id) || done
            }
            if (!done) {
              throw new Error(`pending uninstall ${change.id}: 无法定位持久装配记录`)
            }
          }
        } catch (error) {
          ;(ctx as unknown as { logger?: (name: string) => { error?(msg: string): void } })
            .logger?.('plugin-manage')?.error?.('pending apply 失败: ' + change.id + ' ' + messageOf(error))
        }
      }
    },
  }
}

export { messageOf }
