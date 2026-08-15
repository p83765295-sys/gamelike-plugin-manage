/**
 * M2 插件安装：本地目录 / .tgz 上传 / GitHub clone / npm pack。
 *
 * 两阶段设计（配合安装队列并行）：
 *   prepare* —— 下载/解压/依赖/构建，各任务独立目录，可并行；
 *   activatePrepared —— 写 profile bundles + junction + loader.create，
 *                       由队列串行执行（共享 profile 文件与 loader 树）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { create as tarCreate, x as tarExtract } from 'tar'
import { parseDocument, stringify as yamlStringify } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { ResolvedPaths } from './config.js'
import { addBundle, messageOf, readUserBundles } from './profile.js'
import type { ExportPackResult, PackGroup, PluginGroup } from './types.js'

export type StepFn = (text: string, level?: 'info' | 'ok' | 'warn' | 'error') => void

export interface InstallResult {
  name: string
  entryId: string
  dir: string
  message: string
}

export interface InstallOptions {
  /** 用户明确授权后，才允许执行 npm install / 构建脚本（默认 false） */
  allowBuild?: boolean
  onStep?: StepFn
  /** 阶段进度回调（0-100） */
  onProgress?: (value: number) => void
}

/** 插件包里一个待安装插件的实际目录 */
export interface PreparedPackPlugin {
  name: string
  dir: string
}

export interface PreparedPack {
  groups: PackGroup[]
  plugins: PreparedPackPlugin[]
}

export interface Prepared {
  kind: 'single' | 'suite' | 'pack'
  name: string
  dir: string
  /** 待激活的插件目录（按顺序） */
  plugins: string[]
  /** 待复制的预设目录 */
  presets: string[]
  /** 准备阶段已经给出的提示（已装/跳过等；level=error 会以红色显示） */
  notes: { text: string; level: 'info' | 'ok' | 'warn' | 'error' }[]
  /** kind==='pack' 时：manifest 里的分组与插件目录映射 */
  pack?: PreparedPack
}

const MAX_SOURCE_LEN = 500
const MAX_TGZ_BYTES = 128 * 1024 * 1024

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'development' },
    })
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

function readPkg(dir: string): {
  name: string
  main?: string
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
  bundlePatch?: string
  /** 是否声明了 dsh.bundle 或 dsh.client（真正的 DSH 插件包） */
  isDshPackage?: boolean
} {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) throw new Error(`目录中没有 package.json: ${dir}`)
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as {
    name?: unknown
    main?: unknown
    scripts?: Record<string, string>
    devDependencies?: Record<string, string>
    dsh?: { bundle?: { patch?: unknown }; client?: unknown }
  }
  const name = typeof pkg.name === 'string' ? pkg.name.trim() : ''
  if (!name) throw new Error(`package.json 缺少 name: ${path}`)
  const patch = pkg.dsh?.bundle?.patch
  return {
    name,
    main: typeof pkg.main === 'string' ? pkg.main : undefined,
    scripts: pkg.scripts,
    devDependencies: pkg.devDependencies,
    bundlePatch: typeof patch === 'string' ? patch : undefined,
    isDshPackage: !!(pkg.dsh && (pkg.dsh.bundle || pkg.dsh.client)),
  }
}

function isInstalled(paths: ResolvedPaths, name: string): boolean {
  return readUserBundles(paths.packagePath).some((bundle) => bundle.name === name)
}

/** 复用 DSH 宿主已验证的 node-pty（同版本整目录 symlink，否则复制二进制） */
function patchNodePty(dir: string): void {
  const local = join(dir, 'node_modules', 'node-pty')
  if (!existsSync(join(local, 'package.json'))) return
  const nodeRequire = createRequire(import.meta.url)
  const loadable = (file: string): boolean => {
    try { nodeRequire(file); return true } catch { return false }
  }
  let globalRoot = ''
  try { globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim() } catch { /* ignore */ }
  const candidates = [
    ...(globalRoot ? [join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', 'node-pty')] : []),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/node-pty',
  ]
  for (const host of candidates) {
    const hostBinary = join(host, 'build', 'Release', 'pty.node')
    if (!existsSync(hostBinary) || !loadable(hostBinary)) continue
    try {
      const localVersion = JSON.parse(readFileSync(join(local, 'package.json'), 'utf8')).version
      const hostVersion = JSON.parse(readFileSync(join(host, 'package.json'), 'utf8')).version
      if (localVersion === hostVersion) {
        rmSync(local, { recursive: true, force: true })
        symlinkSync(host, local, process.platform === 'win32' ? 'junction' : 'dir')
        return
      }
    } catch { /* 版本读取失败 → 二进制复制 */ }
    mkdirSync(join(local, 'build', 'Release'), { recursive: true })
    copyFileSync(hostBinary, join(local, 'build', 'Release', 'pty.node'))
    return
  }
}

/** 依赖安装（零脚本）：解压包/克隆仓库没有 node_modules 时必须先装依赖 */
function ensureDependencies(dir: string, opts: InstallOptions, step: StepFn): void {
  if (existsSync(join(dir, 'node_modules'))) {
    opts.onProgress?.(40)
    return
  }
  const pkg = readPkg(dir)
  opts.onProgress?.(20)
  step('安装依赖（npm install --ignore-scripts，不执行生命周期脚本）…')
  try {
    run('npm', ['install', '--include=dev', '--no-audit', '--no-fund', '--ignore-scripts'], dir, 240_000)
  } catch (error) {
    throw new Error(`自动安装依赖失败（可本地构建后重试）: ${messageOf(error)}`)
  }
  opts.onProgress?.(40)
  try {
    if (pkg.devDependencies?.tsdown && !existsSync(join(dir, 'node_modules', 'unrun'))) {
      step('补齐 tsdown 构建器依赖（unrun）…')
      run('npm', ['install', '--no-save', '--ignore-scripts', 'unrun'], dir, 120_000)
    }
    if (opts.allowBuild) {
      step('重建原生依赖（node-pty 等）…')
      run('npm', ['rebuild', '--foreground-scripts'], dir, 300_000)
    }
  } catch (error) {
    throw new Error(`补齐构建器/原生依赖失败: ${messageOf(error)}`)
  }
}

/** lib 缺失时按授权决定是否构建；默认拒绝（构建 = 执行第三方代码） */
function ensureBuilt(dir: string, opts: InstallOptions, step: StepFn): void {
  if (existsSync(join(dir, 'lib'))) {
    opts.onProgress?.(70)
    return
  }
  if (!opts.allowBuild) {
    throw new Error(
      '该包尚未构建（缺少 lib/）。自动构建会在本机执行 npm install 与构建脚本，存在代码执行风险；' +
      '信任该来源的话请勾选「允许执行构建脚本」后重试，或先在本地构建好再安装。',
    )
  }
  const pkg = readPkg(dir)
  step('执行构建脚本…')
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
  opts.onProgress?.(70)
}

/** 一个插件目录的完整准备（依赖 + 构建 + 原生补丁） */
function prepareDir(dir: string, opts: InstallOptions, step: StepFn): void {
  readPkg(dir)
  opts.onProgress?.(15)
  ensureDependencies(dir, opts, step)
  ensureBuilt(dir, opts, step)
  patchNodePty(dir)
  opts.onProgress?.(80)
  step(`准备完成: ${dir}`, 'ok')
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
    if (existsSync(join(dir, 'preset.yml')) && existsSync(join(dir, 'agent.cordis.yml'))) presets.push(dir)
    if (existsSync(join(dir, 'package.json'))) {
      plugins.push(dir)
      return
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

/** 复制目录但排除 node_modules/.git（插件依赖由安装器按需重装） */
function copyTreeExclude(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  let entries: string[] = []
  try { entries = readdirSync(src) } catch { return }
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
    } catch { /* 单个文件复制失败不阻断整个导出 */ }
  }
}

/** 计算目录内容聚合 sha256（文件相对路径 + 内容；排除 node_modules/.git） */
function sha256OfDir(dir: string): string {
  const root = resolve(dir)
  const files: string[] = []
  const walk = (d: string) => {
    let entries: string[] = []
    try { entries = readdirSync(d) } catch { return }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git') continue
      const child = join(d, name)
      try {
        const st = lstatSync(child)
        if (st.isDirectory()) walk(child)
        else if (st.isFile()) files.push(relative(root, child))
      } catch { /* ignore */ }
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

function posixPath(value: string): string {
  return value.split(sep).join('/')
}

/** 解析已安装用户插件的实际目录（link: 目录或 profile node_modules 包） */
export function resolveInstalledDir(paths: ResolvedPaths, name: string): string | undefined {
  const pkg = (() => {
    try {
      return JSON.parse(readFileSync(paths.packagePath, 'utf8')) as {
        dependencies?: Record<string, string>
      }
    } catch {
      return {}
    }
  })()
  const dep = pkg.dependencies?.[name]
  if (typeof dep === 'string' && dep.startsWith('link:')) {
    const rel = dep.slice('link:'.length)
    return isAbsolute(rel) ? rel : join(paths.profileDir, rel)
  }
  return join(paths.profileDir, 'node_modules', ...name.split('/'))
}

/** 插件包检测：顶层 package.json 声明 dsh.pack 且存在 manifest.yml */
function isPackDir(dir: string): boolean {
  const pkgPath = join(dir, 'package.json')
  const manifestPath = join(dir, 'manifest.yml')
  if (!existsSync(pkgPath) || !existsSync(manifestPath)) return false
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dsh?: { pack?: unknown } }
    return !!pkg.dsh?.pack
  } catch {
    return false
  }
}

/** 读取插件包 manifest（只认声明式文件；返回分组清单） */
export function readPackManifest(root: string): { groups: PackGroup[]; packageJson: Record<string, unknown> } {
  const manifestPath = join(root, 'manifest.yml')
  if (!existsSync(manifestPath)) throw new Error('插件包缺少 manifest.yml')
  const doc = parseDocument(readFileSync(manifestPath, 'utf8'))
  if (doc.errors.length) throw new Error('manifest.yml 解析失败: ' + doc.errors.map((e) => e.message).join('; '))
  const data = doc.toJS() as {
    groups?: Array<{
      name?: unknown
      desired?: unknown
      plugins?: Array<{ name?: unknown; path?: unknown; sha256?: unknown }>
    }>
  }
  if (!Array.isArray(data.groups) || data.groups.length === 0) throw new Error('插件包 manifest.yml 缺少 groups')
  const groups: PackGroup[] = data.groups.map((g) => ({
    name: String(g.name ?? '').trim(),
    desired: g.desired === 'enabled' || g.desired === 'disabled' ? g.desired : 'as-is',
    plugins: Array.isArray(g.plugins)
      ? g.plugins.map((p) => ({
          name: String(p.name ?? '').trim(),
          path: String(p.path ?? '').trim(),
          sha256: String(p.sha256 ?? '').trim(),
        }))
      : [],
  }))
  if (groups.some((g) => !g.name)) throw new Error('插件包 manifest.yml 存在空分组名')
  return { groups, packageJson: (doc.toJS() as Record<string, unknown>) ?? {} }
}

/** 校验插件目录仍在解包根内（防 manifest path 越界） */
function safeStagePath(root: string, relPath: string): string {
  const rootResolved = resolve(root)
  const target = resolve(root, relPath)
  const rel = relative(rootResolved, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`非法插件路径: ${relPath}`)
  }
  return target
}

/** 从已解包的插件包 stage 准备插件（复制到 pluginsDir + 依赖/构建） */
async function preparePackFromStage(paths: ResolvedPaths, root: string, opts: InstallOptions): Promise<Prepared> {
  const step = opts.onStep ?? (() => {})
  const { groups } = readPackManifest(root)
  const packPkg = readPkg(root)
  const preparedPlugins: PreparedPackPlugin[] = []
  const notes: Prepared['notes'] = []

  for (const group of groups) {
    for (const plugin of group.plugins) {
      const name = plugin.name
      if (!name) {
        notes.push({ text: `跳过缺少 name 的插件条目`, level: 'error' })
        continue
      }
      const src = safeStagePath(root, plugin.path || join('plugins', ...name.split('/')))
      try {
        readPkg(src)
      } catch (error) {
        notes.push({ text: `插件目录无效: ${name}: ${messageOf(error)}`, level: 'error' })
        continue
      }
      if (isInstalled(paths, name)) {
        notes.push({ text: `已安装，跳过准备: ${name}`, level: 'warn' })
        const existingDir = resolveInstalledDir(paths, name) || src
        preparedPlugins.push({ name, dir: existingDir })
        continue
      }
      const dest = join(paths.pluginsDir, ...name.split('/'))
      try {
        rmSync(dest, { recursive: true, force: true })
        mkdirSync(dirname(dest), { recursive: true })
        cpSync(src, dest, { recursive: true })
        step(`安装插件包成员: ${name}`)
        prepareDir(dest, opts, step)
        preparedPlugins.push({ name, dir: dest })
      } catch (error) {
        notes.push({ text: `插件包成员准备失败: ${name}: ${messageOf(error)}`, level: 'error' })
      }
    }
  }

  return {
    kind: 'pack',
    name: 'pack:' + packPkg.name,
    dir: root,
    plugins: preparedPlugins.map((p) => p.dir),
    presets: [],
    notes,
    pack: { groups, plugins: preparedPlugins },
  }
}

/** M1 更新：link 目录优先 git pull；无 git 则按 M2 流程重准备（依赖 + 构建） */
export function prepareUpdate(paths: ResolvedPaths, pluginName: string, opts: InstallOptions = {}): Prepared {
  const step = opts.onStep ?? (() => {})
  opts.onProgress?.(5)
  const dir = resolveInstalledDir(paths, pluginName)
  if (!dir || !existsSync(join(dir, 'package.json'))) {
    throw new Error(`无法定位插件目录: ${pluginName}（仅支持 link:/目录形式安装的用户插件）`)
  }
  if (existsSync(join(dir, '.git'))) {
    step(`git pull: ${dir}`)
    run('git', ['pull'], dir, 180_000)
    opts.onProgress?.(80)
    step(`已拉取最新代码: ${pluginName}`, 'ok')
  } else {
    step(`该目录不是 git 仓库，按 M2 流程重新准备（依赖/构建）: ${pluginName}`)
    prepareDir(dir, opts, step)
  }
  return { kind: 'single', name: pluginName, dir, plugins: [dir], presets: [], notes: [] }
}

/** 复制一个声明式预设目录到 ~/.dsh/.agent-presets/<basename>；已存在则跳过（不覆盖） */
function copyPreset(paths: ResolvedPaths, src: string): string {
  const id = basename(src)
  const dest = join(paths.home, '.agent-presets', id)
  if (existsSync(dest)) return `预设已存在，跳过: ${id}`
  cpSync(src, dest, { recursive: true })
  return `已安装预设: ${id} → ${dest}`
}

// ═══════════════════════ prepare（可并行） ═══════════════════════

export function prepareLocal(paths: ResolvedPaths, rawPath: string, opts: InstallOptions = {}): Prepared {
  const step = opts.onStep ?? (() => {})
  opts.onProgress?.(5)
  step(`解析路径: ${rawPath}`)
  const dir = toLinuxPath(rawPath)
  if (!existsSync(join(dir, 'package.json'))) throw new Error(`未找到插件目录（缺少 package.json）: ${dir}`)
  const pkg = readPkg(dir)
  prepareDir(dir, opts, step)
  return { kind: 'single', name: pkg.name, dir, plugins: [dir], presets: [], notes: [] }
}

export async function prepareTgz(
  paths: ResolvedPaths,
  fileName: string,
  buffer: Buffer,
  opts: InstallOptions = {},
): Promise<Prepared> {
  const step = opts.onStep ?? (() => {})
  if (buffer.length > MAX_TGZ_BYTES) throw new Error('tgz 超过 128MB 限制')
  if (!/\.(tgz|tar\.gz)$/i.test(fileName)) throw new Error('仅支持 .tgz / .tar.gz 压缩包')
  const work = join(tmpdir(), 'plugin-manage-tgz-' + Date.now())
  const tgzPath = join(work, 'upload.tgz')
  const unpack = join(work, 'pkg')
  mkdirSync(unpack, { recursive: true })
  opts.onProgress?.(8)
  step(`接收上传包: ${fileName}`)
  try {
    writeFileSync(tgzPath, buffer)
    try {
      step('解压 tgz（剥离顶层 package/）…')
      await tarExtract({ file: tgzPath, cwd: unpack, strip: 1 })
    } catch {
      step('解压 tgz（无顶层目录，直接解包）…')
      rmSync(unpack, { recursive: true, force: true })
      mkdirSync(unpack, { recursive: true })
      await tarExtract({ file: tgzPath, cwd: unpack })
    }
    if (isPackDir(unpack)) {
      opts.onProgress?.(30)
      step('识别为 DSH 插件包（package.json + manifest.yml），准备包内插件…')
      return await preparePackFromStage(paths, unpack, opts)
    }
    const name = readPkg(unpack).name
    const dest = join(paths.pluginsDir, name)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dirname(dest), { recursive: true })
    opts.onProgress?.(30)
    step('写入安装目录…')
    cpSync(unpack, dest, { recursive: true })
    prepareDir(dest, opts, step)
    return { kind: 'single', name, dir: dest, plugins: [dest], presets: [], notes: [] }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** 提取 "npm install pkg" / "npm i pkg@1" 中的包说明符 */
function npmSpecOf(source: string): string {
  const tokens = source.trim().split(/\s+/).filter((t) => !['npm', 'install', 'i', 'add'].includes(t) && !t.startsWith('-'))
  return tokens[0] || source.trim()
}

export async function prepareSource(paths: ResolvedPaths, source: string, opts: InstallOptions = {}): Promise<Prepared> {
  const step = opts.onStep ?? (() => {})
  opts.onProgress?.(3)
  const raw = source.trim()
  if (!raw || raw.length > MAX_SOURCE_LEN) throw new Error('请输入有效的 GitHub 地址或 npm 包名/安装指令')
  const text = /^(github\.com|gitlab\.com)\//i.test(raw) ? 'https://' + raw : raw
  const isUrl = /^(https?:\/\/|git@)/i.test(text)

  if (isUrl) {
    const slug = basename(text.replace(/\.git$/, '').replace(/[#?].*$/, '')) || 'repo'
    const target = join(paths.pluginsDir, slug)
    if (existsSync(target)) {
      step(`目录已存在，复用（上次 clone / 安装失败可重试）: ${target}`, 'warn')
    } else {
      mkdirSync(dirname(target), { recursive: true })
      step(`git clone ${text} …`)
      try {
        run('git', ['clone', '--depth', '1', '--recurse-submodules', text, target], dirname(target), 300_000)
      } catch (error) {
        rmSync(target, { recursive: true, force: true })
        throw new Error(`git clone 失败: ${messageOf(error)}`)
      }
      step('clone 完成，识别仓库结构…')
    }
    try {
      if (existsSync(join(target, 'package.json'))) {
        prepareDir(target, opts, step)
        return { kind: 'single', name: readPkg(target).name, dir: target, plugins: [target], presets: [], notes: [] }
      }
      const suite = detectSuite(target)
      if (!suite.plugins.length && !suite.presets.length) {
        throw new Error('该仓库既不是插件包（顶层 package.json）也不是可识别的套装（package.json 或 preset.yml+agent.cordis.yml 子目录）')
      }
      step(`识别为套装：${suite.plugins.length} 个 package.json 目录，${suite.presets.length} 个预设目录`)
      const notes: Prepared['notes'] = []
      const preparedPlugins: string[] = []
      for (const pluginDir of suite.plugins) {
        try {
          const info = readPkg(pluginDir)
          if (!info.isDshPackage) {
            notes.push({ text: `跳过非 DSH 插件目录（无 dsh.bundle / dsh.client，不构建）: ${pluginDir}`, level: 'warn' })
            continue
          }
          prepareDir(pluginDir, opts, step)
          preparedPlugins.push(pluginDir)
        } catch (error) {
          notes.push({ text: `插件目录准备失败: ${pluginDir}: ${messageOf(error)}`, level: 'error' })
        }
      }
      return { kind: 'suite', name: 'suite:' + slug, dir: target, plugins: preparedPlugins, presets: suite.presets, notes }
    } catch (error) {
      rmSync(target, { recursive: true, force: true })
      throw new Error(`GitHub 安装准备失败（已清理残留）: ${messageOf(error)}`)
    }
  }

  // npm 包名 / 安装指令 / 本地目录 → npm pack 成 tgz → 复用 tgz 流程
  const spec = npmSpecOf(text)
  const work = join(tmpdir(), 'plugin-manage-npm-' + Date.now())
  mkdirSync(work, { recursive: true })
  opts.onProgress?.(8)
  step(`npm pack ${spec} …`)
  try {
    run('npm', ['pack', spec, '--pack-destination', work], work, 300_000)
    const tgz = readdirSync(work).find((f) => /\.tgz$/.test(f))
    if (!tgz) throw new Error(`npm pack 未产出 tgz: ${spec}`)
    opts.onProgress?.(25)
    step('npm pack 完成，转入解压安装…')
    return await prepareTgz(paths, tgz, readFileSync(join(work, tgz)), opts)
  } catch (error) {
    throw new Error(`npm 安装失败: ${messageOf(error)}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ═══════════════════════ activate（队列串行） ═══════════════════════

/**
 * 写 profile bundles + junction + loader.create。
 * 必须由队列串行调用：共享 profile package.json 与 loader 树。
 */
export async function activatePrepared(
  ctx: Context,
  paths: ResolvedPaths,
  prepared: Prepared,
  opts: InstallOptions = {},
): Promise<InstallResult[]> {
  const step = opts.onStep ?? (() => {})
  const results: InstallResult[] = []
  for (const dir of prepared.plugins) {
    const pkg = readPkg(dir)
    if (isInstalled(paths, pkg.name)) {
      step(`已安装，跳过: ${pkg.name}`, 'warn')
      results.push({ name: pkg.name, entryId: '', dir, message: `「${pkg.name}」已在 bundles 中，跳过` })
      continue
    }
    const entryFile = resolve(dir, pkg.main || 'lib/index.js')
    if (!existsSync(entryFile)) throw new Error(`找不到插件入口: ${entryFile}（package.json main 或 lib/index.js）`)
    opts.onProgress?.(88)
    step(`检查插件入口: ${pkg.name}`)
    let hasApply = false
    try {
      const mod = await import(entryFile)
      const candidate = typeof mod === 'function' ? mod : (mod as { apply?: unknown; default?: { apply?: unknown } }).apply ?? (mod as { default?: { apply?: unknown } }).default?.apply
      hasApply = typeof candidate === 'function'
    } catch (error) {
      // 入口无法导入时交给 loader.create 给出权威错误
      hasApply = true
    }

    addBundle(paths.packagePath, pkg.name, 'link:' + dir)
    ensureJunction(paths, pkg.name, dir)

    if (!hasApply && pkg.bundlePatch) {
      // Skill-only / 配置层 bundle：不 loader.create 自己的入口，
      // 由 include 在装配 bundles 时应用它的 cordis.patch.yml（重启生效）。
      step(`配置层插件（bundle-only），已写入 bundles，重启后由 include 装配其 patch`, 'warn')
      opts.onProgress?.(100)
      results.push({
        name: pkg.name,
        entryId: '',
        dir,
        message: `已安装「${pkg.name}」（配置层插件）：已写入 profile bundles，重启 DSH 后由 include 装配生效。`,
      })
      continue
    }
    if (!hasApply && (prepared.kind === 'suite' || prepared.kind === 'pack')) {
      try { rmSync(join(paths.profileDir, 'node_modules', ...pkg.name.split('/')), { recursive: true, force: true }) } catch {}
      try { removeBundle(paths.packagePath, pkg.name) } catch {}
      step(`跳过非插件目录（main 未导出 apply）: ${pkg.name}`, 'warn')
      results.push({ name: pkg.name, entryId: '', dir, message: `跳过「${pkg.name}」：不是 DSH 插件入口（main 未导出 apply）` })
      continue
    }

    step(`装配 ${pkg.name} …`)
    let entryId: unknown
    try {
      const loader = ctx.loader as Loader
      entryId = await loader.create({ id: pkg.name, name: entryFile } as never)
    } catch (error) {
      try { rmSync(join(paths.profileDir, 'node_modules', ...pkg.name.split('/')), { recursive: true, force: true }) } catch {}
      try { removeBundle(paths.packagePath, pkg.name) } catch {}
      throw new Error(`装配失败（已回滚配置）: ${messageOf(error)}`)
    }
    opts.onProgress?.(100)
    step(`装配成功: ${pkg.name}`, 'ok')
    results.push({
      name: pkg.name,
      entryId: String(entryId),
      dir,
      message: `已安装「${pkg.name}」：立即装配成功，且已写入 profile bundles（重启后仍在）。`,
    })
  }
  for (const presetDir of prepared.presets) {
    step(copyPreset(paths, presetDir), 'ok')
  }
  for (const note of prepared.notes) step(note.text, note.level)
  return results
}

function ensureJunction(paths: ResolvedPaths, name: string, target: string): void {
  const link = join(paths.profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dirname(link), { recursive: true })
  try {
    lstatSync(link)
    rmSync(link, { recursive: true, force: true })
  } catch {
    // 不存在 → 继续
  }
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

function removeBundle(path: string, bundleName: string): boolean {
  // 回滚专用：与 profile.ts 的 removeBundle 同语义（不备份无关）
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  const bundles = (pkg.dsh?.profile?.bundles ?? []).filter((n: string) => n !== bundleName)
  if (pkg.dependencies?.[bundleName]) delete pkg.dependencies[bundleName]
  pkg.dsh = { ...pkg.dsh, profile: { ...pkg.dsh?.profile, bundles } }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
  return true
}

// ═══════════════════════ M4 插件包导出 ═══════════════════════

/**
 * 把若干分组导出为 DSH 插件包（.tgz）：
 *   package.json（合成元数据，供 M2 识别）
 *   manifest.yml（分组 + 插件清单 + sha256）
 *   plugins/<包名>/（插件目录本体，排除 node_modules/.git）
 */
export async function exportPack(
  paths: ResolvedPaths,
  groups: PluginGroup[],
  packName = 'dsh-plugin-pack',
): Promise<ExportPackResult> {
  const step = (text: string): void => {
    // 导出不走安装队列，这里不记录步骤；保留调用方日志
  }
  void step
  const activeGroups = groups.filter((g) => g.plugins.length > 0)
  if (activeGroups.length === 0) throw new Error('没有可导出的插件：请先创建分组并加入插件')

  const seen = new Set<string>()
  const pluginDirs = new Map<string, string>()
  for (const group of activeGroups) {
    for (const pluginName of group.plugins) {
      if (seen.has(pluginName)) continue
      const dir = resolveInstalledDir(paths, pluginName)
      if (!dir || !existsSync(join(dir, 'package.json'))) {
        throw new Error(`无法导出「${pluginName}」：找不到已安装插件目录（${dir || '未解析'}）`)
      }
      seen.add(pluginName)
      pluginDirs.set(pluginName, dir)
    }
  }

  const stamp = Date.now()
  const safeName = packName.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'dsh-plugin-pack'
  const fileName = `${safeName}.tgz`
  const work = join(tmpdir(), 'plugin-manage-export-' + stamp)
  const stageRoot = join(work, safeName)
  const pluginsStage = join(stageRoot, 'plugins')
  mkdirSync(pluginsStage, { recursive: true })

  try {
    const manifestGroups: PackGroup[] = activeGroups.map((group) => ({
      name: group.name,
      desired: group.desired,
      plugins: group.plugins.map((pluginName) => {
        const target = join(pluginsStage, ...pluginName.split('/'))
        copyTreeExclude(pluginDirs.get(pluginName)!, target)
        const sha256 = sha256OfDir(target)
        return {
          name: pluginName,
          path: posixPath(join('plugins', ...pluginName.split('/'))),
          sha256,
        }
      }),
    }))

    const pkgJson = {
      name: safeName,
      version: '1.0.0',
      private: true,
      description: `DSH 插件包：${activeGroups.map((g) => g.name).join('、')}（由插件管理导出）`,
      dsh: {
        pack: {
          format: 'dsh-plugin-pack@1',
          manifest: 'manifest.yml',
        },
      },
    }
    const manifest = {
      pack: {
        name: safeName,
        version: '1.0.0',
        format: 'dsh-plugin-pack@1',
        exportedAt: new Date(stamp).toISOString(),
        profile: paths.profile,
      },
      groups: manifestGroups,
    }

    writeFileSync(join(stageRoot, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n')
    writeFileSync(join(stageRoot, 'manifest.yml'), yamlStringify(manifest))
    const tgzPath = join(work, fileName)
    await tarCreate(
      { gzip: true, file: tgzPath, cwd: work, portable: true },
      [safeName],
    )
    return {
      fileName,
      filePath: tgzPath,
      pluginCount: seen.size,
      groups: activeGroups.map((g) => g.name),
    }
  } catch (error) {
    throw new Error(`导出插件包失败: ${messageOf(error)}`)
  } finally {
    // 注意：tgz 在 work 根下，返回后由调用方读取；读取完成前不能清理。
    // 这里不删除 work，由调用方在发送完成后清理。
  }
}

/** 删除导出工作目录（调用方在下载完成后调用） */
export function cleanupExport(filePath: string): void {
  try {
    rmSync(dirname(filePath), { recursive: true, force: true })
  } catch {
    // 忽略清理失败
  }
}
