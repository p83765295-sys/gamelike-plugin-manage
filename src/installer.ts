/**
 * M2 插件安装：本地目录 / .tgz 上传 / GitHub clone / npm pack。
 *
 * 两阶段设计（配合安装队列并行）：
 *   prepare* —— 下载/解压/依赖/构建，各任务独立目录，可并行；
 *   activatePrepared —— 写 profile bundles + junction + loader.create，
 *                       由队列串行执行（共享 profile 文件与 loader 树）。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { x as tarExtract } from 'tar'
import type { Context } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { ResolvedPaths } from './config.js'
import { addBundle, messageOf, readUserBundles } from './profile.js'

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

export interface Prepared {
  kind: 'single' | 'suite'
  name: string
  dir: string
  /** 待激活的插件目录（按顺序） */
  plugins: string[]
  /** 待复制的预设目录 */
  presets: string[]
  /** 准备阶段已经给出的提示（已装/跳过等；level=error 会以红色显示） */
  notes: { text: string; level: 'info' | 'ok' | 'warn' | 'error' }[]
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
    if (!hasApply && prepared.kind === 'suite') {
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
