/**
 * 持久层读写：profile 的 package.json（dependencies + dsh.profile.bundles）
 * 与 cordis.patch.yml（用户的最高优先级覆盖层）。
 *
 * M1 的操作只写这两个文件 + pending 记录；不调用 ctx.loader 的运行时方法，
 * 因此当前进程不动，重启 DSH 后按新配置装配生效。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isMap, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml'
import type { PendingChange } from './types.js'

export interface ProfileBundle {
  /** 包名（bundles 数组中的原始项） */
  name: string
  /** package.json dependencies 里的说明符（link:/…、github:…、^1.0.0） */
  specifier?: string
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

function backup(path: string): void {
  if (!existsSync(path)) return
  try {
    copyFileSync(path, path + '.bak')
  } catch {
    // 备份失败不致命；写操作本身仍是原子的
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { messageOf }

// ═══════════════════════ profile package.json ═══════════════════════

interface ProfilePackage {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

export function readProfilePackage(path: string): ProfilePackage {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as ProfilePackage
    return data ?? {}
  } catch (error) {
    throw new Error(`读取 profile package.json 失败: ${messageOf(error)}`)
  }
}

/** 读用户 bundle 列表（排除官方底座 @deepseek-ai/dsh-base / dsh-web-app 不必要，调用处按前缀再判） */
export function readUserBundles(path: string): ProfileBundle[] {
  const pkg = readProfilePackage(path)
  const bundles = pkg.dsh?.profile?.bundles ?? []
  const deps = pkg.dependencies ?? {}
  return bundles.map((name) => ({ name, specifier: deps[name] }))
}

/**
 * 从 bundles 与 dependencies 中同时移除一个用户包。
 * 返回是否真的改动了文件。
 */
export function removeBundle(path: string, bundleName: string): boolean {
  const pkg = readProfilePackage(path)
  const bundles = pkg.dsh?.profile?.bundles ?? []
  const deps = pkg.dependencies ?? {}
  let changed = false

  const nextBundles = bundles.filter((name) => name !== bundleName)
  if (nextBundles.length !== bundles.length) changed = true
  if (Object.prototype.hasOwnProperty.call(deps, bundleName)) {
    delete deps[bundleName]
    changed = true
  }

  if (!changed) return false
  const next = { ...pkg }
  next.dependencies = deps
  next.dsh = { ...pkg.dsh, profile: { ...pkg.dsh?.profile, bundles: nextBundles } }
  backup(path)
  atomicWrite(path, JSON.stringify(next, null, 2) + '\n')
  return true
}

// ═══════════════════════ cordis.patch.yml ═══════════════════════

function emptyPatchDocument(): Document {
  return parseDocument('[]')
}

export function readPatchDocument(path: string): Document {
  if (!existsSync(path)) return emptyPatchDocument()
  const text = readFileSync(path, 'utf8')
  const doc = parseDocument(text)
  if (doc.errors.length) {
    throw new Error('cordis.patch.yml 解析失败: ' + doc.errors.map((e) => e.message).join('; '))
  }
  if (doc.contents === null) {
    return emptyPatchDocument()
  }
  if (!isSeq(doc.contents)) {
    throw new Error('cordis.patch.yml 顶层必须是 YAML 数组（loader patch entries）')
  }
  return doc
}

function writePatchDocument(path: string, doc: Document): void {
  backup(path)
  atomicWrite(path, String(doc))
}

function topSeq(doc: Document): YAMLSeq {
  return doc.contents as YAMLSeq
}

/** 找顶层 `- id: X ...` 条目（不进入 insert 子列表） */
export function findTopEntry(doc: Document, id: string): YAMLMap | undefined {
  for (const item of topSeq(doc).items) {
    if (!isMap(item)) continue
    if (String(item.get('id') ?? '') === id) return item
  }
  return undefined
}

/**
 * 显式写一条顶层 `disabled: true|false` 覆盖。
 * - 已有同 id 条目 → 只改/加 disabled 键，保留其它 config；
 * - 没有 → 追加一条仅含 id + disabled 的新条目。
 */
export function writePatchDisabled(path: string, id: string, disabled: boolean): void {
  const doc = readPatchDocument(path)
  const item = findTopEntry(doc, id)
  if (item) {
    item.set('disabled', doc.createNode(disabled))
  } else {
    const node = doc.createNode({ id, disabled }) as YAMLMap
    node.commentBefore = ' plugin-manage: 待重启生效（' + (disabled ? '禁用' : '启用') + ' ' + id + '）'
    topSeq(doc).add(node)
  }
  writePatchDocument(path, doc)
}

/** 读出 patch 里所有 insert 子行的 id（用户通过 patch 插入的插件） */
export function readPatchInsertIds(path: string): Set<string> {
  const ids = new Set<string>()
  if (!existsSync(path)) return ids
  const doc = readPatchDocument(path)
  for (const item of topSeq(doc).items) {
    if (!isMap(item)) continue
    const insert = item.get('insert')
    if (!isSeq(insert)) continue
    for (const child of insert.items) {
      if (isMap(child) && typeof child.get('id') === 'string') {
        ids.add(child.get('id') as string)
      }
    }
  }
  return ids
}

/** 读出 patch 顶层 `disabled: true` 的条目 id 集合（用于冲突预检与卸载意图判断） */
export function readPatchDisabledIds(path: string): Set<string> {
  const ids = new Set<string>()
  if (!existsSync(path)) return ids
  const doc = readPatchDocument(path)
  for (const item of topSeq(doc).items) {
    if (!isMap(item)) continue
    const id = String(item.get('id') ?? '')
    const disabled = (item.get('disabled') as { value?: unknown } | null)?.value
    if (id && disabled === true) ids.add(id)
  }
  return ids
}

/**
 * 从 patch 的 insert 子列表中删除一个插件行（用户插件的持久卸载）。
 * insert 列表清空后整条 insert 也一并删除。
 */
export function removePatchInsert(path: string, id: string): boolean {
  const doc = readPatchDocument(path)
  const seq = topSeq(doc)
  let removed = false
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const item = seq.items[i]
    if (!isMap(item)) continue
    const insert = item.get('insert')
    if (!isSeq(insert)) continue
    for (let j = insert.items.length - 1; j >= 0; j--) {
      const child = insert.items[j]
      if (isMap(child) && String(child.get('id') ?? '') === id) {
        insert.items.splice(j, 1)
        removed = true
      }
    }
    if (insert.items.length === 0) {
      seq.items.splice(i, 1)
    }
  }
  if (!removed) return false
  writePatchDocument(path, doc)
  return true
}

// ═══════════════════════ pending（待重启）记录 ═══════════════════════

interface PendingFile {
  version: 1
  entries: PendingChange[]
}

export function readPending(path: string): PendingChange[] {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as PendingFile
    return Array.isArray(data?.entries) ? data.entries : []
  } catch {
    return []
  }
}

export function writePending(path: string, entries: PendingChange[]): void {
  const data: PendingFile = { version: 1, entries }
  atomicWrite(path, JSON.stringify(data, null, 2) + '\n')
}

/** upsert 一条 pending（同 id 覆盖为最新操作） */
export function upsertPending(path: string, change: PendingChange): PendingChange[] {
  const next = readPending(path).filter((c) => c.id !== change.id)
  next.push(change)
  writePending(path, next)
  return next
}

/**
 * 清除已生效的 pending：当前运行状态已与期望一致（禁用已禁用 /
 * 启用已启用 / 卸载已不在运行树）。返回清理后的列表（有变化则落盘）。
 */
export function prunePending(
  path: string,
  pending: PendingChange[],
  runningIds: Map<string, boolean>,
): PendingChange[] {
  const next = pending.filter((change) => {
    const enabled = runningIds.get(change.id)
    if (change.op === 'uninstall') return enabled !== undefined // 仍在运行 → 保留
    if (enabled === undefined) return false // 行已经没了 → 视为已生效
    if (change.op === 'disable') return enabled !== false
    if (change.op === 'enable') return enabled !== true
    return false
  })
  if (next.length !== pending.length) writePending(path, next)
  return next
}

/** 取一个 id 当前的 pending 变更 */
export function pendingOf(pending: PendingChange[], id: string): PendingChange | undefined {
  return pending.find((c) => c.id === id)
}

// 给 UI 展示的路径常量
export const PROFILE_PATCH_HELP = '操作写入 cordis.patch.yml / profile package.json，重启 DSH 后生效'

/** 卸载前 patch 顶层同 id 条目的 disabled 状态快照 */
export interface PatchDisabledState {
  existed: boolean
  disabledBefore?: boolean | null
  hadDisabledKey: boolean
}

export function snapshotPatchDisabled(path: string, id: string): PatchDisabledState {
  const doc = readPatchDocument(path)
  const item = findTopEntry(doc, id)
  if (!item) return { existed: false, hadDisabledKey: false }
  const had = item.has('disabled')
  const value = had ? (item.get('disabled') as { value?: unknown } | null)?.value : undefined
  return {
    existed: true,
    hadDisabledKey: had,
    disabledBefore: value === undefined || value === null ? null : (value === true || value === false ? value : null),
  }
}

/** 逆操作：把 patch 顶层同 id 条目恢复到快照状态（精确，不影响其它条目） */
export function restorePatchDisabled(path: string, id: string, state: PatchDisabledState): void {
  const doc = readPatchDocument(path)
  const seq = topSeq(doc)
  const item = findTopEntry(doc, id)
  if (!state.existed) {
    // 卸载时我们追加的新条目 → 整条删除
    for (let i = seq.items.length - 1; i >= 0; i--) {
      const node = seq.items[i]
      if (isMap(node) && String(node.get('id') ?? '') === id) {
        seq.items.splice(i, 1)
        break
      }
    }
  } else if (item) {
    if (state.hadDisabledKey) {
      item.set('disabled', doc.createNode(state.disabledBefore))
    } else {
      item.delete('disabled')
    }
  }
  writePatchDocument(path, doc)
}

/** 卸载前 patch insert 里同 id 行的内容快照（不存在返回 undefined） */
export function snapshotPatchInsert(path: string, id: string): unknown {
  if (!existsSync(path)) return undefined
  const doc = readPatchDocument(path)
  for (const item of topSeq(doc).items) {
    if (!isMap(item)) continue
    const insert = item.get('insert')
    if (!isSeq(insert)) continue
    for (const child of insert.items) {
      if (isMap(child) && String(child.get('id') ?? '') === id) return child.toJS(doc)
    }
  }
  return undefined
}

/** 逆操作：把被删的 insert 行放回 patch（已有则不动；insert 条目被整体删除时重建） */
export function restorePatchInsert(path: string, id: string, line: unknown): void {
  const doc = readPatchDocument(path)
  const seq = topSeq(doc)
  let insert: YAMLSeq | undefined
  for (const item of seq.items) {
    if (isMap(item) && isSeq(item.get('insert'))) {
      insert = item.get('insert') as YAMLSeq
      break
    }
  }
  if (insert) {
    for (const child of insert.items) {
      if (isMap(child) && String(child.get('id') ?? '') === id) {
        writePatchDocument(path, doc)
        return
      }
    }
    insert.add(doc.createNode(line))
  } else {
    seq.add(doc.createNode({ insert: [line] }))
  }
  writePatchDocument(path, doc)
}

/** 逆操作：把 bundle 名加回 dsh.profile.bundles（幂等）+ 恢复 dependencies 说明符 */
export function addBundle(path: string, name: string, specifier?: string): boolean {
  const pkg = readProfilePackage(path)
  const bundles = pkg.dsh?.profile?.bundles ?? []
  const deps = pkg.dependencies ?? {}
  let changed = false
  if (!bundles.includes(name)) {
    bundles.push(name)
    changed = true
  }
  if (specifier !== undefined && deps[name] !== specifier) {
    deps[name] = specifier
    changed = true
  }
  if (!changed) return false
  const next = { ...pkg }
  next.dependencies = deps
  next.dsh = { ...pkg.dsh, profile: { ...pkg.dsh?.profile, bundles } }
  backup(path)
  atomicWrite(path, JSON.stringify(next, null, 2) + '\n')
  return true
}

/** 删除一条 pending（取消卸载后调用） */
export function removePending(path: string, id: string): PendingChange[] {
  const next = readPending(path).filter((c) => c.id !== id)
  writePending(path, next)
  return next
}

/** 用户 bundle 的 patch 插入行 id → bundle 包名（用于把官方包名但用户插入的行归类为用户插件） */
export function readBundleInsertMap(packagePath: string, profileDir: string): Map<string, string> {
  const map = new Map<string, string>()
  const pkg = readProfilePackage(packagePath)
  const bundles = pkg.dsh?.profile?.bundles ?? []
  const deps = pkg.dependencies ?? {}
  const OFFICIAL_BASE = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  for (const name of bundles) {
    if (OFFICIAL_BASE.has(name)) continue
    let dir = ''
    const dep = deps[name]
    if (typeof dep === 'string' && dep.startsWith('link:')) {
      const rel = dep.slice('link:'.length)
      dir = rel.startsWith('/') ? rel : join(profileDir, rel)
    } else {
      dir = join(profileDir, 'node_modules', ...name.split('/'))
    }
    if (!existsSync(dir)) continue
    try {
      const pkgJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const patchRel = pkgJson.dsh?.bundle?.patch
      if (typeof patchRel !== 'string') continue
      const patchPath = join(dir, patchRel)
      if (!existsSync(patchPath)) continue
      const patchDoc = readPatchDocument(patchPath)
      for (const item of topSeq(patchDoc).items) {
        if (!isMap(item)) continue
        const insert = item.get('insert')
        if (!isSeq(insert)) continue
        for (const child of insert.items) {
          if (!isMap(child)) continue
          const rowId = child.get('id')
          if (typeof rowId === 'string' && rowId) map.set(rowId, name)
          const rowName = child.get('name')
          if (typeof rowName === 'string' && rowName) map.set(rowName, name)
        }
      }
    } catch {
      // 单个 bundle 元数据损坏不影响其它分类
    }
  }
  return map
}
