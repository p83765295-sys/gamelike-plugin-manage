/**
 * Agent 预设归属与清理。
 *
 * 只按两条可信路径识别「插件拥有的本地预设」：
 *  1. plugin-manage 安装器复制预设时写入的 .plugin-manage-owner.json；
 *  2. 第三方插件自管理预设时留下的 *.owner.json（如 dsh-agent-rp 的
 *     .dsh-agent-rp-owner.json，其中 owner 为 bundle 包名）。
 *
 * 绝不通过解析 agent.cordis.yml 反推归属：用户自建预设也可能引用同一
 * 插件，禁用插件不应删除用户的本地创作。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ResolvedPaths } from './config.js'
import { readBundleInsertMap } from './profile.js'

/** plugin-manage 安装器写入的归属标记 */
export const PLUGIN_MANAGE_OWNER_FILE = '.plugin-manage-owner.json'

export interface AgentPresetRow {
  id: string
  trust: 'system' | 'user'
  path: string
  name?: string
}

export interface AgentPresetsService {
  list(): Promise<AgentPresetRow[]>
  remove(id: string): Promise<unknown>
}

/** 读取宿主 agentPresets 服务；不可用时返回 undefined（清理静默跳过）。 */
export function agentPresetsOf(ctx: unknown): AgentPresetsService | undefined {
  try {
    const service = (ctx as { get?: (name: string) => unknown }).get?.('agentPresets')
    if (!service || typeof (service as AgentPresetsService).list !== 'function' || typeof (service as AgentPresetsService).remove !== 'function') return undefined
    return service as AgentPresetsService
  } catch {
    return undefined
  }
}

/** 为 plugin-manage 复制的预设写入归属标记（不覆盖已有标记）。 */
export function writePluginManageOwnerMarker(presetDir: string, owners: string[]): void {
  const marker = join(presetDir, PLUGIN_MANAGE_OWNER_FILE)
  if (existsSync(marker)) return
  writeFileSync(marker, JSON.stringify({ format: 0, owners: [...new Set(owners.filter(Boolean))] }, null, 2) + '\n', 'utf8')
}

function ownersOfRecord(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return []
}

/** 读取一个预设目录内的全部归属标记（1 + 2 两条路径）。 */
export function readPresetOwners(presetDir: string): string[] {
  const owners = new Set<string>()
  try {
    const marker = join(presetDir, PLUGIN_MANAGE_OWNER_FILE)
    if (existsSync(marker)) {
      const record = JSON.parse(readFileSync(marker, 'utf8')) as { owners?: unknown; owner?: unknown }
      for (const owner of [...ownersOfRecord(record.owners), ...ownersOfRecord(record.owner)]) owners.add(owner)
    }
    for (const file of readdirSync(presetDir)) {
      if (file === PLUGIN_MANAGE_OWNER_FILE || !/owner\.json$/i.test(file)) continue
      try {
        const record = JSON.parse(readFileSync(join(presetDir, file), 'utf8')) as { owner?: unknown; owners?: unknown }
        for (const owner of [...ownersOfRecord(record.owner), ...ownersOfRecord(record.owners)]) owners.add(owner)
      } catch {
        // 单个标记损坏不影响其它路径
      }
    }
  } catch {
    // 预设目录不可读 → 无归属，不删除
  }
  return [...owners]
}

/**
 * 从宿主列出的本地预设中找出 bundleName 拥有的预设 id。
 * 归属名会经 readBundleInsertMap 规范化：旧运行名/插入行 id 也算。
 */
export function ownedPresetIdsForBundle(paths: ResolvedPaths, rows: AgentPresetRow[], bundleName: string): string[] {
  const bundleInserts = readBundleInsertMap(paths.packagePath, paths.profileDir)
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.trust !== 'user') continue
    const owners = readPresetOwners(dirname(row.path))
    if (owners.some((owner) => (bundleInserts.get(owner) ?? owner) === bundleName)) ids.add(row.id)
  }
  return [...ids]
}

export interface PresetRemovalResult {
  removed: string[]
  failed: Array<{ id: string; error: string }>
}

/** 调用宿主服务删除本地预设；单个失败不阻断其余清理。 */
export async function removeOwnedPresets(service: AgentPresetsService, presetIds: string[]): Promise<PresetRemovalResult> {
  const removed: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  for (const id of [...new Set(presetIds)]) {
    try {
      await service.remove(id)
      removed.push(id)
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { removed, failed }
}
