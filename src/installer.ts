/**
 * M2 插件安装：本地目录 / .tgz 拖拽上传 / GitHub clone / npm pack。
 * 统一落点：profile package.json（dependencies: link:… + dsh.profile.bundles）
 * + node_modules junction + 立即 loader.create（免重启生效，重启后由 bundles 接管）。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { x as tarExtract } from 'tar'
import type { Context } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { ResolvedPaths } from './config.js'
import { addBundle, messageOf, readUserBundles, removeBundle } from './profile.js'

export interface InstallResult {
  name: string
  entryId: string
  dir: string
  message: string
}

export interface InstallOptions {
  /** 用户明确授权后，才允许执行 npm install / 构建脚本（默认 false） */
  allowBuild?: boolean
}

const MAX_SOURCE_LEN = 500
const MAX_TGZ_BYTES = 128 * 1024 * 1024

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): string {
  try {
    return execFileSync(cmd, args, { cwd, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const e = error as { status?: number; stderr?: string; message?: string }
    throw new Error(`${cmd} ${args.join(' ')} 失败: ${e.stderr || e.message || error}`)
  }
}

/** 把 Windows 路径（C:\Users\...）转成 WSL 路径（/mnt/c/Users/...）；其它原样解析 */
export function toLinuxPath(input: string): string {
  const text = input.trim().replace(/^["']|["']$/g, '')
  const win = text.match(/^([A-Za-z]):[\\/](.*)$/)
  if (win) return `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, '/')}`
  return resolve(text)
}

function readPkg(dir: string): { name: string; main?: string; scripts?: Record<string, string> } {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) throw new Error(`目录中没有 package.json: ${dir}`)
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; main?: unknown; scripts?: Record<string, string> }
  const name = typeof pkg.name === 'string' ? pkg.name.trim() : ''
  if (!name) throw new Error(`package.json 缺少 name: ${path}`)
  return { name, main: typeof pkg.main === 'string' ? pkg.main : undefined, scripts: pkg.scripts }
}

function isInstalled(paths: ResolvedPaths, name: string): boolean {
  return readUserBundles(paths.packagePath).some((bundle) => bundle.name === name)
}

function ensureJunction(paths: ResolvedPaths, name: string, target: string): void {
  const link = join(paths.profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dirname(link), { recursive: true })
  try {
    lstatSync(link) // 任何已存在的路径（含悬空 symlink）都先清理
    rmSync(link, { recursive: true, force: true })
  } catch {
    // 不存在 → 继续
  }
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

/** 目录没有 lib/ 时按授权决定是否构建；默认拒绝（构建 = 执行第三方代码） */
function ensureBuilt(dir: string, opts: InstallOptions): void {
  if (existsSync(join(dir, 'lib'))) return
  if (!opts.allowBuild) {
    throw new Error(
      '该包尚未构建（缺少 lib/）。自动构建会在本机执行 npm install 与构建脚本，存在代码执行风险；' +
      '信任该来源的话请勾选「允许执行构建脚本」后重试，或先在本地构建好再安装。',
    )
  }
  const pkg = readPkg(dir)
  try {
    run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts=false'], dir, 240_000)
  } catch (error) {
    throw new Error(`自动安装依赖失败（可本地构建后重试）: ${messageOf(error)}`)
  }
  try {
    if (pkg.scripts?.build) {
      run('npm', ['run', 'build'], dir, 300_000)
    } else if (existsSync(join(dir, 'scripts', 'build.sh'))) {
      run('bash', ['scripts/build.sh'], dir, 300_000)
    } else {
      throw new Error('目录缺少 lib/，且没有 build 脚本（npm run build / scripts/build.sh），请本地构建后重试')
    }
  } catch (error) {
    throw new Error(`自动构建失败（可本地构建后重试）: ${messageOf(error)}`)
  }
  if (!existsSync(join(dir, 'lib'))) throw new Error('构建完成但仍未生成 lib/，请检查构建脚本')
}

async function installDir(ctx: Context, paths: ResolvedPaths, dir: string, opts: InstallOptions = {}): Promise<InstallResult> {
  const pkg = readPkg(dir)
  if (isInstalled(paths, pkg.name)) {
    throw new Error(`「${pkg.name}」已在 bundles 中；如需更新请先在 M1 卸载后再安装`)
  }
  ensureBuilt(dir, opts)
  const entryFile = resolve(dir, pkg.main || 'lib/index.js')
  if (!existsSync(entryFile)) throw new Error(`找不到插件入口: ${entryFile}（package.json main 或 lib/index.js）`)
  addBundle(paths.packagePath, pkg.name, 'link:' + dir)
  ensureJunction(paths, pkg.name, dir)
  let entryId: unknown
  try {
    const loader = ctx.loader as Loader
    entryId = await loader.create({ id: pkg.name, name: entryFile } as never)
  } catch (error) {
    // 装配失败 → 回滚刚落盘的 bundles / junction，避免「配置说装了但跑不起来」
    try { rmSync(join(paths.profileDir, 'node_modules', ...pkg.name.split('/')), { recursive: true, force: true }) } catch {}
    try { removeBundle(paths.packagePath, pkg.name) } catch {}
    throw new Error(`装配失败（已回滚配置）: ${messageOf(error)}`)
  }
  return {
    name: pkg.name,
    entryId: String(entryId),
    dir,
    message: `已安装「${pkg.name}」：立即装配成功，且已写入 profile bundles（重启后仍在）。`,
  }
}

/** M2-a：本地目录路径 */
export async function installLocal(ctx: Context, paths: ResolvedPaths, rawPath: string, opts: InstallOptions = {}): Promise<InstallResult> {
  const dir = toLinuxPath(rawPath)
  if (!existsSync(join(dir, 'package.json'))) throw new Error(`未找到插件目录（缺少 package.json）: ${dir}`)
  return installDir(ctx, paths, dir, opts)
}

/** M2-b：拖拽上传的 .tgz */
export async function installTgz(
  ctx: Context,
  paths: ResolvedPaths,
  fileName: string,
  buffer: Buffer,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  if (buffer.length > MAX_TGZ_BYTES) throw new Error('tgz 超过 128MB 限制')
  if (!/\.(tgz|tar\.gz)$/i.test(fileName)) throw new Error('仅支持 .tgz / .tar.gz 压缩包')
  const work = join(tmpdir(), 'plugin-manage-tgz-' + Date.now())
  const tgzPath = join(work, 'upload.tgz')
  const unpack = join(work, 'pkg')
  mkdirSync(unpack, { recursive: true })
  try {
    writeFileSync(tgzPath, buffer)
    try {
      await tarExtract({ file: tgzPath, cwd: unpack, strip: 1 })
    } catch {
      // 有些包没有顶层 package/ 目录，退回不剥离重试
      rmSync(unpack, { recursive: true, force: true })
      mkdirSync(unpack, { recursive: true })
      await tarExtract({ file: tgzPath, cwd: unpack })
    }
    const name = readPkg(unpack).name
    if (isInstalled(paths, name)) {
      throw new Error(`「${name}」已在 bundles 中；如需更新请先在 M1 卸载后再安装`)
    }
    const dest = join(paths.home, 'extensions', name)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(unpack, dest, { recursive: true })
    return installDir(ctx, paths, dest, opts)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** 声明式套装识别：只认标准文件，绝不执行 install.ps1 / *.sh / git hooks */
export function detectSuite(root: string): { plugins: string[]; presets: string[] } {
  const plugins: string[] = []
  const presets: string[] = []
  const seen = new Set<string>()
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || seen.has(dir)) return
    seen.add(dir)
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    const hasPackage = existsSync(join(dir, 'package.json'))
    const hasPreset = existsSync(join(dir, 'preset.yml')) && existsSync(join(dir, 'agent.cordis.yml'))
    if (hasPreset) presets.push(dir)
    if (hasPackage) {
      plugins.push(dir)
      return // 插件目录不再深入（node_modules 等内部结构与本仓库安装无关）
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue
      const child = join(dir, name)
      try { if (lstatSync(child).isDirectory()) walk(child, depth + 1) } catch { /* ignore */ }
    }
  }
  walk(root, 0)
  return { plugins, presets }
}

/** 复制一个声明式预设目录到 ~/.dsh/.agent-presets/<basename>；已存在则跳过（不覆盖用户数据） */
function copyPreset(paths: ResolvedPaths, src: string): string {
  const id = basename(src)
  const dest = join(paths.home, '.agent-presets', id)
  if (existsSync(dest)) return `预设已存在，跳过: ${id}`
  cpSync(src, dest, { recursive: true })
  return `已安装预设: ${id} → ${dest}`
}

/** 提取 "npm install pkg" / "npm i pkg@1" 中的包说明符 */
function npmSpecOf(source: string): string {
  const tokens = source.trim().split(/\s+/).filter((t) => !['npm', 'install', 'i', 'add'].includes(t) && !t.startsWith('-'))
  return tokens[0] || source.trim()
}

/** M2-c/d：GitHub 地址或 npm 指令（自动识别） */
export async function installSource(ctx: Context, paths: ResolvedPaths, source: string, opts: InstallOptions = {}): Promise<InstallResult> {
  const raw = source.trim()
  if (!raw || raw.length > MAX_SOURCE_LEN) throw new Error('请输入有效的 GitHub 地址或 npm 包名/安装指令')
  // 用户常省略协议直接写 github.com/user/repo → 补全
  const text = /^(github\.com|gitlab\.com)\//i.test(raw) ? 'https://' + raw : raw
  const isUrl = /^(https?:\/\/|git@)/i.test(text)

  if (isUrl) {
    const slug = basename(text.replace(/\.git$/, '').replace(/[#?].*$/, '')) || 'repo'
    const target = join(paths.home, 'extensions', slug)
    if (existsSync(target)) throw new Error(`目录已存在: ${target}（请先删除或换一个仓库）`)
    mkdirSync(dirname(target), { recursive: true })
    try {
      run('git', ['clone', '--depth', '1', '--recurse-submodules', text, target], dirname(target), 300_000)
      // 顶层是标准插件包 → 直接装；否则按声明式白名单识别套装（不执行任何脚本）
      if (existsSync(join(target, 'package.json'))) {
        return await installDir(ctx, paths, target, opts)
      }
      const suite = detectSuite(target)
      if (!suite.plugins.length && !suite.presets.length) {
        throw new Error('该仓库既不是插件包（顶层 package.json）也不是可识别的套装（package.json 或 preset.yml+agent.cordis.yml 子目录）')
      }
      const notes: string[] = []
      for (const pluginDir of suite.plugins) {
        try {
          const result = await installDir(ctx, paths, pluginDir, opts)
          notes.push(result.message)
        } catch (error) {
          notes.push(`跳过 ${pluginDir}: ${messageOf(error)}`)
        }
      }
      for (const presetDir of suite.presets) {
        try { notes.push(copyPreset(paths, presetDir)) } catch (error) { notes.push(`预设复制失败 ${presetDir}: ${messageOf(error)}`) }
      }
      return {
        name: 'suite:' + slug,
        entryId: '',
        dir: target,
        message: `套装识别完成（未执行任何仓库自带脚本）：\n` + notes.join('\n'),
      }
    } catch (error) {
      // clone / 装配失败：清掉本次 clone 的残留目录，避免留下半成品
      rmSync(target, { recursive: true, force: true })
      throw new Error(`GitHub 安装失败（已清理残留）: ${messageOf(error)}`)
    }
  }

  // npm 包名 / 安装指令 / 本地目录 → npm pack 成 tgz → 走 tgz 流程
  const spec = npmSpecOf(text)
  const work = join(tmpdir(), 'plugin-manage-npm-' + Date.now())
  mkdirSync(work, { recursive: true })
  try {
    run('npm', ['pack', spec, '--pack-destination', work], work, 300_000)
    const tgz = readdirSync(work).find((f) => /\.tgz$/.test(f))
    if (!tgz) throw new Error(`npm pack 未产出 tgz: ${spec}`)
    return await installTgz(ctx, paths, tgz, readFileSync(join(work, tgz)), opts)
  } catch (error) {
    throw new Error(`npm 安装失败: ${messageOf(error)}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
