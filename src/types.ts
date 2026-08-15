/** 共享类型：插件管理（M1 管理插件） */

/** 插件来源分类（native = DSH 原生插件） */
export type PluginSource = 'native' | 'user' | 'injected'

/** 重启后期望状态 */
export type DesiredState = 'enabled' | 'disabled' | 'removed'

/** 一条已落盘的待重启变更 */
export interface PendingChange {
  id: string
  op: 'disable' | 'enable' | 'uninstall'
  ts: number
  /** 仅 uninstall 有：撤销信息 */
  undo?: UninstallUndo
}

/** loader entry tree 里一条 entry 的运行投影 */
export interface RunningPlugin {
  id: string
  name: string
  enabled: boolean
  fiberPhase: string | null
}

/** 列表里的一条插件（运行状态 + 期望状态 + 来源） */
export interface PluginItem {
  id: string
  name: string
  source: PluginSource
  running: RunningPlugin
  desired: DesiredState
  /** 是否有未生效的待重启变更 */
  pending: boolean
  /** 是否允许持久卸载（官方插件不允许） */
  uninstallable: boolean
  /** 临时注入提示 */
  ephemeral?: string
}

/** GET /list 返回的完整快照 */
export interface PluginManageSnapshot {
  profile: string
  profileDir: string
  patchPath: string
  packagePath: string
  items: PluginItem[]
  pending: PendingChange[]
}

/** 一次操作的结果 */
export interface ActionOk {
  id: string
  op: PendingChange['op']
  message: string
}

/** 卸载的撤销信息：精确逆操作所需的最小状态 */
export interface UninstallUndo {
  /** bundle 装配信息（从 package.json 移除的包） */
  bundle?: { name: string; specifier?: string }
  /** 卸载前 patch 顶层同 id 条目的状态 */
  patchDisabled?: { existed: boolean; disabledBefore?: boolean | null; hadDisabledKey: boolean }
  /** 卸载前 patch insert 里同 id 行的内容（被删除则非空） */
  patchInsert?: unknown
}
