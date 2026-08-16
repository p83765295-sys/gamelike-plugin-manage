/**
 * PluginStore：内容寻址插件存储 + 插件身份。
 *
 * 目标是让「不同插件包存在交集」从「复制与跳过」变成「集合运算」：
 * - 每个插件版本在 store 里只有一份物理实体（按 name + version + sha256 寻址）；
 * - 导入包先把成员吸收进 store，再基于身份做装配计划（dry-run）；
 * - version + sha256 组成身份，交集判断不再只有「名字相同就跳过」。
 *
 * 存储布局：
 *   ~/.dsh/plugin-store/<name>/<version>-<sha256[:12]>/   （插件目录本体，不含 node_modules/.git）
 *   ~/.dsh/plugin-store/<name>/.registry.json               （该包名下已吸收的版本清单）
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { ResolvedPaths } from './config.js'

export interface RegisteredVersion {
  name: string
  version: string
  sha256: string
  /** 吸收进 store 的实际目录 */
  dir: string
  /** 吸收时间 */
  ts: number
}

export interface AbsorbedPlugin {
  name: string
  version: string
  sha256: string
  /** store 中的实体目录 */
  dir: string
  /** 是否之前已存在（true = 交集去重，无需重复复制） */
  existed: boolean
}

export function storeRoot(paths: ResolvedPaths): string {
  return join(paths.home, 'plugin-store')
}

function storeNameDir(paths: ResolvedPaths, name: string): string {
  return join(storeRoot(paths), ...name.split('/'))
}

function registryPath(paths: ResolvedPaths, name: string): string {
  return join(storeNameDir(paths, name), '.registry.json')
}

/** 计算目录内容聚合 sha256（文件相对路径 + 内容；排除 node_modules/.git） */
export function sha256OfDir(dir: string): string {
  const root = resolve(dir)
  const files: string[] = []
  const walk = (d: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git') continue
      const child = join(d, name)
      try {
        const st = lstatSync(child)
        if (st.isDirectory()) walk(child)
        else if (st.isFile()) files.push(relative(root, child))
      } catch {
        // 单个文件读取失败不影响整体
      }
    }
  }
  walk(root)
  files.sort()
  const hash = createHash('sha256')
  for (const rel of files) {
    hash.update(rel.replace(/\\/g, '/') + '\0')
    hash.update(readFileSync(join(root, rel)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** 读包名下的注册版本清单 */
export function readRegistry(paths: ResolvedPaths, name: string): RegisteredVersion[] {
  try {
    const data = JSON.parse(readFileSync(registryPath(paths, name), 'utf8')) as {
      versions?: Array<{ version: string; sha256: string; dir: string; ts: number }>
    }
    return Array.isArray(data.versions)
      ? data.versions
          .filter((v) => typeof v?.version === 'string' && typeof v?.sha256 === 'string' && typeof v?.dir === 'string')
          .map((v) => ({ name, version: v.version, sha256: v.sha256, dir: v.dir, ts: v.ts || 0 }))
      : []
  } catch {
    return []
  }
}

/** 按哈希找到 store 里已吸收的实体目录（跨版本复用同内容） */
export function findStored(paths: ResolvedPaths, name: string, sha256: string): string | undefined {
  for (const reg of readRegistry(paths, name)) {
    if (reg.sha256 === sha256 && existsSync(join(reg.dir, 'package.json'))) return reg.dir
  }
  return undefined
}

function writeRegistry(paths: ResolvedPaths, name: string, versions: RegisteredVersion[]): void {
  const dir = storeNameDir(paths, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    registryPath(paths, name),
    JSON.stringify({ name, versions: versions.map((v) => ({ version: v.version, sha256: v.sha256, dir: v.dir, ts: v.ts })) }, null, 2) + '\n',
  )
}

/** 复制目录但排除 node_modules/.git（插件依赖由安装器按需重装） */
export function copyTreeExclude(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  let entries: string[] = []
  try {
    entries = readdirSync(src)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git') continue
    const child = join(src, name)
    const target = join(dest, name)
    try {
      const st = lstatSync(child)
      if (st.isDirectory()) copyTreeExclude(child, target)
      else if (st.isFile()) {
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(child, target)
      }
    } catch {
      // 单个文件复制失败不阻断整体
    }
  }
}

/**
 * 把插件目录吸收进 PluginStore（内容寻址）：
 * - 同 sha256 已存在 → 直接复用（交集去重，不重复复制）；
 * - 否则吸收为 `<name>/<version>-<sha256[:12]>` 并登记。
 * 返回 store 里的实体目录。version 缺失时回退为 `0.0.0-unknown`。
 */
export function absorbPlugin(paths: ResolvedPaths, src: string, name: string, version?: string, expectedSha256?: string): AbsorbedPlugin {
  // 先计算内容哈希（吸收前校验，避免把已损坏/不一致的数据存入 store）
  const sha256 = sha256OfDir(src)
  if (expectedSha256 && expectedSha256 !== sha256) {
    throw new Error(`插件内容校验失败: ${name}（manifest sha256=${expectedSha256.slice(0, 12)}… 实际=${sha256.slice(0, 12)}…）`)
  }
  const existing = findStored(paths, name, sha256)
  if (existing) {
    // 实体版本以 store 内 package.json 为准，避免外部声明与实体不一致
    return { name, version: readVersion(existing) || version || '0.0.0-unknown', sha256, dir: existing, existed: true }
  }
  const resolvedVersion = version || readVersion(src) || '0.0.0-unknown'
  const target = join(storeNameDir(paths, name), `${resolvedVersion}-${sha256.slice(0, 12)}`)
  const registry = readRegistry(paths, name)
  const occupied = registry.find((v) => v.version === resolvedVersion)
  if (occupied) {
    // 同名同版本但内容不同：这是真正的「版本硬冲突」。
    // 保留旧实体，新内容另存一个带哈希后缀的实体，由装配计划仲裁。
    const alt = `${resolvedVersion}-${sha256.slice(0, 12)}-${Date.now().toString(36)}`
    const altDir = join(storeNameDir(paths, name), alt)
    rmSync(altDir, { recursive: true, force: true })
    copyTreeExclude(src, altDir)
    registry.push({ name, version: resolvedVersion, sha256, dir: altDir, ts: Date.now() })
    writeRegistry(paths, name, registry)
    return { name, version: resolvedVersion, sha256, dir: altDir, existed: false }
  }
  rmSync(target, { recursive: true, force: true })
  copyTreeExclude(src, target)
  registry.push({ name, version: resolvedVersion, sha256, dir: target, ts: Date.now() })
  writeRegistry(paths, name, registry)
  return { name, version: resolvedVersion, sha256, dir: target, existed: false }
}

/** 读取目录 package.json 的 version */
export function readVersion(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/** 读取目录 package.json 的 dsh.bundle.patch 相对路径 */
export function readBundlePatchRel(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: unknown } } }
    return typeof pkg.dsh?.bundle?.patch === 'string' ? pkg.dsh.bundle.patch : undefined
  } catch {
    return undefined
  }
}

/** Windows/posix 统一路径分隔符 */
export function posixPath(value: string): string {
  return value.split(sep).join('/')
}
