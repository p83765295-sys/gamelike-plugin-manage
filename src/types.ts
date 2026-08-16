/** 共享类型：插件管理（M1 管理插件） */

/** 插件来源分类（native = DSH 原生插件） */
export type PluginSource = 'native' | 'user' | 'injected'

/** 重启后期望状态 */
export type DesiredState = 'enabled' | 'disabled' | 'removed'

/** 一条已落盘的待重启变更 */
export interface PendingChange {
  id: string
  op: 'disable' | 'enable' | 'uninstall' | 'update'
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
  /** 所属分组名（M4 创建，M1 展示；多归属时取第一个） */
  group?: string
  /** 所属的全部分组名（M4 多归属） */
  groups: string[]
  /** 已安装用户插件的版本（来自 package.json version） */
  version?: string
  /** 图标接口地址（仅用户插件；找不到图标时该地址返回 404，UI 自动隐藏） */
  iconUrl?: string
}

/** M4 插件分组（映射到 M1） */
export interface PluginGroup {
  name: string
  desired: 'enabled' | 'disabled' | 'as-is'
  plugins: string[]
}

/** GET /list 返回的完整快照 */
export interface PluginManageSnapshot {
  profile: string
  profileDir: string
  patchPath: string
  packagePath: string
  items: PluginItem[]
  pending: PendingChange[]
  groups: PluginGroup[]
}

/** 导出的插件包 manifest 里的一组 */
export interface PackGroup {
  name: string
  desired: 'enabled' | 'disabled' | 'as-is'
  plugins: { name: string; path: string; version?: string; sha256?: string }[]
}

/** 插件身份：包名 + 版本 + 内容哈希 */
export interface PluginIdentity {
  name: string
  version: string
  /** 插件目录聚合 sha256（导出时计算，安装时校验） */
  sha256?: string
}

/** 插件包安装计划：对每个成员的裁决结果 */
export interface PlanItem {
  identity: PluginIdentity
  /** 来源目录（已吸收进 PluginStore 的实体，或已安装的现有目录） */
  dir: string
  /** 决策 */
  decision: 'install' | 'skip-installed' | 'conflict'
  /** skip 时说明原因；冲突时给出可选动作 */
  reason: string
  /** 冲突级别：info 提示 / warn 可忽略 / error 阻断 */
  level: 'info' | 'warn' | 'error'
}

/** 包级安装计划（dry-run 产物） */
export interface InstallPlan {
  items: PlanItem[]
  /** 是否全部被跳过（没有真正需要装配的插件） */
  allSkipped: boolean
  /** 阻断性冲突数 */
  blocking: number
  /** 计划将要实际装配的插件目录（保持顺序） */
  toActivate: string[]
}

/** 导出插件包结果 */
export interface ExportPackResult {
  fileName: string
  filePath: string
  /** 导出的插件数 */
  pluginCount: number
  groups: string[]
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
