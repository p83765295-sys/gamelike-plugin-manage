/**
 * 插件分组持久层：~/.dsh/plugin-manage-groups.yml。
 *
 * 分组是插件包（M4）与 M1 之间的映射层：
 * - M4 创建/编辑分组，导出为插件包 manifest；
 * - M1 显示分组徽标、按分组过滤、整组启用/禁用。
 * 一个插件（按包名 name 标识）同一时刻只能属于一个分组。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseDocument, isMap, isSeq, type Document, type YAMLMap, type YAMLSeq } from 'yaml'

export type GroupDesired = 'enabled' | 'disabled' | 'as-is'

export interface PluginGroup {
  name: string
  desired: GroupDesired
  plugins: string[]
}

interface GroupsFile {
  version: 1
  groups: PluginGroup[]
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, path)
  } catch {
    // Windows 上目标文件已存在时 rename 可能失败（EPERM），先移除再重命名
    rmSync(path, { force: true })
    renameSync(tmp, path)
  }
}

export function readGroups(path: string): PluginGroup[] {
  try {
    const text = readFileSync(path, 'utf8')
    const doc = parseDocument(text)
    if (doc.errors.length) return []
    if (!isMap(doc.contents)) return []
    const groupsNode = doc.contents.get('groups')
    if (!isSeq(groupsNode)) return []
    const groups: PluginGroup[] = []
    for (const item of groupsNode.items) {
      if (!isMap(item)) continue
      const name = String(item.get('name') ?? '').trim()
      if (!name) continue
      const desired = String(item.get('desired') ?? 'as-is') as GroupDesired
      const pluginsNode = item.get('plugins')
      const plugins: string[] = []
      if (isSeq(pluginsNode)) {
        for (const p of pluginsNode.items) {
          const v = String((p as unknown as { value?: unknown } | null)?.value ?? '').trim()
          if (v) plugins.push(v)
        }
      }
      groups.push({
        name,
        desired: desired === 'enabled' || desired === 'disabled' ? desired : 'as-is',
        plugins,
      })
    }
    return groups
  } catch {
    return []
  }
}

export function writeGroups(path: string, groups: PluginGroup[]): void {
  const data: GroupsFile = { version: 1, groups }
  const doc = parseDocument(JSON.stringify(data))
  const node = doc.contents as YAMLMap
  node.set('version', 1)
  node.commentBefore = ' 插件管理分组：M4 创建，M1 展示/过滤/整组启用。一个插件只能属于一个分组。'
  atomicWrite(path, String(doc))
}

/** 保存/覆盖一个分组；并把组内插件从其它分组移除（一个插件只属于一个分组） */
export function upsertGroup(path: string, group: PluginGroup): PluginGroup[] {
  const groups = readGroups(path)
  const next = groups.filter((g) => g.name !== group.name)
  for (const other of next) {
    other.plugins = other.plugins.filter((p) => !group.plugins.includes(p))
  }
  next.push({ name: group.name, desired: group.desired, plugins: [...new Set(group.plugins)] })
  writeGroups(path, next)
  return next
}

export function deleteGroup(path: string, name: string): PluginGroup[] {
  const next = readGroups(path).filter((g) => g.name !== name)
  writeGroups(path, next)
  return next
}

/** 把若干插件从任何分组中移除（不删除空组） */
export function removePluginsFromGroups(path: string, pluginNames: string[]): PluginGroup[] {
  const groups = readGroups(path)
  for (const group of groups) {
    group.plugins = group.plugins.filter((p) => !pluginNames.includes(p))
  }
  writeGroups(path, groups)
  return groups
}

export function groupOfPlugin(groups: PluginGroup[], pluginName: string): PluginGroup | undefined {
  return groups.find((g) => g.plugins.includes(pluginName))
}
