/**
 * 插件图标探测：只在「已安装用户插件目录」内找图标，绝不访问目录外文件。
 *
 * 发现优先级：
 *   1. package.json 的 icon / logo 字段（仅相对路径）
 *   2. 仓库根目录的常见图标文件名（大小写不敏感）
 *   3. README.md 中第一张本地相对路径图片（跳过 http(s)/data/锚点外链）
 *
 * 安全边界：
 *   - 只允许 readUserBundles 中真实存在的用户插件；
 *   - 所有候选路径必须 resolve 后仍位于插件目录内；
 *   - 扩展名白名单 + 2MB 上限；
 *   - SVG 只以 image/svg+xml 经 <img> 提供，不作为 HTML 内联。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ResolvedPaths } from './config.js'
import { resolveInstalledDir } from './installer.js'
import { readUserBundles } from './profile.js'

export interface PluginIcon {
  /** 图标文件的绝对路径 */
  file: string
  /** HTTP Content-Type */
  mime: string
  /** 文件字节数 */
  size: number
}

const MAX_ICON_BYTES = 2 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

const ROOT_ICON_NAMES = [
  'icon.png', 'icon.jpg', 'icon.jpeg', 'icon.webp', 'icon.gif', 'icon.svg',
  'logo.png', 'logo.jpg', 'logo.jpeg', 'logo.webp', 'logo.gif', 'logo.svg',
  'icon-dark.png', 'icon-dark.svg', 'logo-dark.png', 'logo-dark.svg',
]

function isAllowedIconPath(root: string, target: string): boolean {
  if (!isAbsolute(target)) return false
  const rel = relative(resolve(root), resolve(target))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  const ext = extname(target).toLowerCase()
  if (!(ext in MIME)) return false
  return true
}

function iconInfo(file: string): PluginIcon | null {
  try {
    const stat = statSync(file)
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ICON_BYTES) return null
    const ext = extname(file).toLowerCase()
    const mime = MIME[ext]
    if (!mime) return null
    return { file, mime, size: stat.size }
  } catch {
    return null
  }
}

/** 解析 package.json 声明的 icon/logo 相对路径 */
function declaredIcon(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      icon?: unknown
      logo?: unknown
    }
    const declared = typeof pkg.icon === 'string' ? pkg.icon : typeof pkg.logo === 'string' ? pkg.logo : undefined
    if (!declared || /^(https?:|data:|\/\/)/i.test(declared.trim())) return undefined
    const target = resolve(dir, declared.trim().split(/[?#]/, 1)[0])
    return isAllowedIconPath(dir, target) && existsSync(target) ? target : undefined
  } catch {
    return undefined
  }
}

/** 仓库根目录常见图标文件名（大小写不敏感） */
function rootIcon(dir: string): string | undefined {
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  const lower = new Map(entries.map((name) => [name.toLowerCase(), name]))
  for (const candidate of ROOT_ICON_NAMES) {
    const actual = lower.get(candidate.toLowerCase())
    if (!actual) continue
    const target = join(dir, actual)
    if (isAllowedIconPath(dir, target) && existsSync(target)) return target
  }
  return undefined
}

/** README.md 第一张本地相对路径图片 */
function readmeIcon(dir: string): string | undefined {
  for (const readmeName of ['README.md', 'readme.md', 'README.MD', 'README.zh.md', 'README_EN.md']) {
    const readmePath = join(dir, readmeName)
    if (!existsSync(readmePath)) continue
    try {
      const text = readFileSync(readmePath, 'utf8')
      const match = /!\[[^\]]*\]\(\s*(?!["']?(?:https?:|data:|\/\/|#))([^)\s]+)/.exec(text)
      if (!match) continue
      const target = resolve(dir, match[1].trim().split(/[?#]/, 1)[0])
      if (isAllowedIconPath(dir, target) && existsSync(target)) return target
    } catch {
      // 单个 README 读取失败继续
    }
  }
  return undefined
}

/**
 * 探测用户插件图标。name 必须是 profile bundles 中已装配的用户插件包名，
 * 否则返回 null（不读取任何文件）。
 */
export function findPluginIcon(paths: ResolvedPaths, name: string): PluginIcon | null {
  if (!name) return null
  if (!readUserBundles(paths.packagePath).some((bundle) => bundle.name === name)) return null
  const dir = resolveInstalledDir(paths, name)
  if (!dir || !existsSync(join(dir, 'package.json'))) return null
  const candidate = declaredIcon(dir) ?? rootIcon(dir) ?? readmeIcon(dir)
  return candidate ? iconInfo(candidate) : null
}
