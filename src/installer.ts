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
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { create as tarCreate, x as tarExtract } from 'tar'
import { parseDocument, stringify as yamlStringify } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { ResolvedPaths } from './config.js'
import { addBundle, messageOf, readBundleInsertMap, readPatchDisabledIds, readPatchInsertIds, readUserBundles, writePatchDisabled } from './profile.js'
import { absorbPlugin, copyTreeExclude, posixPath, readBundlePatchRel, readVersion, sha256OfDir } from './store.js'
import type { ExportPackResult, InstallPlan, PackGroup, PlanItem, PluginGroup, PluginIdentity } from './types.js'

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

/** 插件包里一个待安装插件的实际目录（吸收进 PluginStore 后的实体） */
export interface PreparedPackPlugin {
  name: string
  dir: string
  version: string
  sha256: string
  /** 是否已在 store 中存在（交集去重） */
  existed: boolean
}

export interface PreparedPack {
  groups: PackGroup[]
  plugins: PreparedPackPlugin[]
}

export interface Prepared {
  kind: 'single' | 'suite' | 'pack'
  name: string
  dir: string
  /** 待激活的插件目录（按顺序；kind==='pack' 时等于 plan.toActivate） */
  plugins: string[]
  /** 待复制的预设目录 */
  presets: string[]
  /** 准备阶段已经给出的提示（已装/跳过等；level=error 会以红色显示） */
  notes: { text: string; level: 'info' | 'ok' | 'warn' | 'error' }[]
  /** kind==='pack' 时：manifest 里的分组与插件目录映射 */
  pack?: PreparedPack
  /** kind==='pack' 时：dry-run 装配计划（交集裁决结果） */
  plan?: InstallPlan
}

const MAX_SOURCE_LEN = 500
const MAX_TGZ_BYTES = 128 * 1024 * 1024

/** Windows 下 npm/npx/node 需要可执行扩展名；bash 在原生 Windows 不可用 */
function resolveCmd(cmd: string): string {
  if (process.platform !== 'win32') return cmd
  if (cmd === 'npm') return 'npm.cmd'
  if (cmd === 'npx') return 'npx.cmd'
  if (cmd === 'node') return 'node.exe'
  if (cmd === 'bash') {
    throw new Error('原生 Windows 环境没有 bash，无法执行 bash 脚本；请使用支持 npm run build 的插件，或先在本地构建好再安装')
  }
  return cmd
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): string {
  try {
    return execFileSync(resolveCmd(cmd), args, {
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

/** 解析用户填写的插件目录：win32 下直接解析 Windows 路径；WSL/Linux 下把 C:\... 转成 /mnt/c/... */
export function toLinuxPath(input: string): string {
  const text = input.trim().replace(/^["']|["']$/g, '')
  if (process.platform !== 'win32') {
    const win = text.match(/^([A-Za-z]):[\\/](.*)$/)
    if (win) return `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, '/')}`
  }
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

/** 已安装用户插件信息（版本来自实体目录 package.json） */
export interface InstalledInfo {
  dir: string
  version?: string
  specifier?: string
}

/** 读已安装用户插件信息（bundles 中存在的包；读取失败返回 undefined） */
export function readInstalledInfo(paths: ResolvedPaths, name: string): InstalledInfo | undefined {
  if (!readUserBundles(paths.packagePath).some((bundle) => bundle.name === name)) return undefined
  const dir = resolveInstalledDir(paths, name)
  if (!dir || !existsSync(join(dir, 'package.json'))) return undefined
  const bundle = readUserBundles(paths.packagePath).find((b) => b.name === name)
  return { dir, version: readVersion(dir), specifier: bundle?.specifier }
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

/** 读取插件包 manifest（只认声明式文件；返回分组清单，兼容 dsh-plugin-pack@1 / @2） */
export function readPackManifest(root: string): { groups: PackGroup[]; format: string; packageJson: Record<string, unknown> } {
  const manifestPath = join(root, 'manifest.yml')
  if (!existsSync(manifestPath)) throw new Error('插件包缺少 manifest.yml')
  const doc = parseDocument(readFileSync(manifestPath, 'utf8'))
  if (doc.errors.length) throw new Error('manifest.yml 解析失败: ' + doc.errors.map((e) => e.message).join('; '))
  const data = doc.toJS() as {
    pack?: { format?: unknown }
    groups?: Array<{
      name?: unknown
      desired?: unknown
      plugins?: Array<{ name?: unknown; path?: unknown; version?: unknown; sha256?: unknown }>
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
          version: String(p.version ?? '').trim() || undefined,
          sha256: String(p.sha256 ?? '').trim() || undefined,
        }))
      : [],
  }))
  if (groups.some((g) => !g.name)) throw new Error('插件包 manifest.yml 存在空分组名')
  return { groups, format: String(data.pack?.format ?? 'dsh-plugin-pack@1'), packageJson: (doc.toJS() as Record<string, unknown>) ?? {} }
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

/**
 * 构建包级装配计划（dry-run）：对吸收进 PluginStore 的候选插件逐一裁决。
 *
 * 交集策略：
 * - 安全交集（同名同版本已装）→ skip-installed，静默去重；
 * - 版本交集（同名不同版本）→ conflict，不静默覆盖，提示人工决定；
 * - 资源交集（entry id 被其它插件占用 / 用户 patch 已声明）→ conflict；
 * - 卸载意图（patch 顶层 disabled 条目）→ 允许安装，激活时清除 disabled
 *   （用户主动导入插件包 = 显式重新安装请求）。
 */
export function buildInstallPlan(
  ctx: Context,
  paths: ResolvedPaths,
  candidates: PreparedPackPlugin[],
): InstallPlan {
  const items: PlanItem[] = []
  const running = new Map<string, string>()
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue
    running.set(entry.id, entry.options.name)
  }
  const patchIds = readPatchInsertIds(paths.patchPath)
  const bundleInserts = readBundleInsertMap(paths.packagePath, paths.profileDir)
  const disabledIds = readPatchDisabledIds(paths.patchPath)

  for (const candidate of candidates) {
    const identity: PluginIdentity = { name: candidate.name, version: candidate.version, sha256: candidate.sha256 }
    const installed = readInstalledInfo(paths, candidate.name)
    if (installed) {
      const sameVersion = !!installed.version && !!candidate.version && installed.version === candidate.version
      if (sameVersion) {
        // 同名同版本：再比较内容哈希（v2 包）。哈希一致才是安全交集；
        // 哈希不同（同名同版本不同内容）按硬冲突处理，不静默覆盖。
        const sameContent = !candidate.sha256 || sha256OfDir(installed.dir) === candidate.sha256
        if (sameContent) {
          items.push({
            identity,
            dir: installed.dir,
            decision: 'skip-installed',
            reason: `已安装同版本同内容 ${installed.version}，交集去重（无需重复装配）`,
            level: 'info',
          })
          continue
        }
        items.push({
          identity,
          dir: installed.dir,
          decision: 'conflict',
          reason: `内容冲突：已安装 ${installed.version}，但包内内容哈希不同（同版本不同内容）。不静默覆盖；请卸载后重试。`,
          level: 'error',
        })
        continue
      }
      items.push({
        identity,
        dir: installed.dir,
        decision: 'conflict',
        reason: `版本冲突：已安装 ${installed.version || '未知版本'}，插件包携带 ${candidate.version || '未知版本'}。不静默覆盖；如需升级请先在插件管理里卸载旧版本，或使用更新功能。`,
        level: 'error',
      })
      continue
    }

    // 资源交集：entry id 已被其它插件占用。
    // 检查三层：loader.create 的包名 id、include 展开前缀、以及包内 cordis.patch.yml 声明的 insert id。
    const checkRunningId = (id: string): string | undefined => {
      const owner = running.get(id)
      if (owner !== undefined && owner !== candidate.name) return owner
      const includeOwner = running.get('include:' + id)
      if (includeOwner !== undefined && includeOwner !== candidate.name) return includeOwner
      return undefined
    }
    const runningOwner = checkRunningId(candidate.name)
    if (runningOwner) {
      items.push({
        identity,
        dir: candidate.dir,
        decision: 'conflict',
        reason: `entry id「${candidate.name}」已被运行树中的「${runningOwner}」占用，不能重复装配。`,
        level: 'error',
      })
      continue
    }
    const ownPatchIds = new Set<string>([candidate.name])
    const bundlePatchRel = readBundlePatchRel(candidate.dir)
    if (bundlePatchRel) {
      for (const id of readPatchInsertIds(join(candidate.dir, bundlePatchRel))) ownPatchIds.add(id)
    }
    for (const id of ownPatchIds) {
      if (id === candidate.name) {
        if (patchIds.has(id)) {
          items.push({
            identity,
            dir: candidate.dir,
            decision: 'conflict',
            reason: `cordis.patch.yml 已存在同 id「${id}」的 insert 行（可能是手工装配），请先在管理列表卸载后重试。`,
            level: 'error',
          })
          continue
        }
      } else {
        // bundle patch 里声明的 insert id 与包名不同（如 archify → skill-filesystem）
        const owner = bundleInserts.get(id)
        if (owner !== undefined && owner !== candidate.name) {
          items.push({
            identity,
            dir: candidate.dir,
            decision: 'conflict',
            reason: `该插件 bundle patch 声明的 entry id「${id}」已被用户插件「${owner}」占用。`,
            level: 'error',
          })
          continue
        }
        if (patchIds.has(id)) {
          items.push({
            identity,
            dir: candidate.dir,
            decision: 'conflict',
            reason: `该插件 bundle patch 声明的 entry id「${id}」已存在于 cordis.patch.yml。`,
            level: 'error',
          })
          continue
        }
        const runningOther = checkRunningId(id)
        if (runningOther) {
          items.push({
            identity,
            dir: candidate.dir,
            decision: 'conflict',
            reason: `该插件 bundle patch 声明的 entry id「${id}」已被运行树中的「${runningOther}」占用。`,
            level: 'error',
          })
          continue
        }
      }
    }

    const note = disabledIds.has(candidate.name)
      ? '检测到该插件此前被禁用/卸载（patch 存在 disabled 覆盖），本次导入将清除该覆盖并按包内版本重新装配。'
      : '未安装，计划装配。'
    items.push({
      identity,
      dir: candidate.dir,
      decision: 'install',
      reason: note,
      level: disabledIds.has(candidate.name) ? 'warn' : 'info',
    })
  }

  const toActivate = items.filter((item) => item.decision === 'install').map((item) => item.dir)
  return {
    items,
    allSkipped: items.length > 0 && toActivate.length === 0,
    blocking: items.filter((item) => item.decision === 'conflict' && item.level === 'error').length,
    toActivate,
  }
}

/** 从已解包的插件包 stage 准备插件：校验 sha256 → 吸收进 PluginStore → dry-run 计划 */
async function preparePackFromStage(paths: ResolvedPaths, root: string, opts: InstallOptions): Promise<Prepared> {
  const step = opts.onStep ?? (() => {})
  const { groups, format } = readPackManifest(root)
  const packPkg = readPkg(root)
  const candidates: PreparedPackPlugin[] = []
  const notes: Prepared['notes'] = []
  const seenNames = new Set<string>()
  const isV2 = format === 'dsh-plugin-pack@2'

  if (!isV2) {
    notes.push({ text: '旧版插件包（dsh-plugin-pack@1）：缺少 version/sha256 声明，将不做内容完整性校验。', level: 'warn' })
  }

  for (const group of groups) {
    for (const plugin of group.plugins) {
      const name = plugin.name
      if (!name) {
        notes.push({ text: '跳过缺少 name 的插件条目', level: 'error' })
        continue
      }
      // 包内同 name 只吸收一次（交集去重在吸收层完成）
      if (seenNames.has(name)) continue
      seenNames.add(name)

      const src = safeStagePath(root, plugin.path || join('plugins', ...name.split('/')))
      try {
        readPkg(src)
      } catch (error) {
        notes.push({ text: `插件目录无效: ${name}: ${messageOf(error)}`, level: 'error' })
        continue
      }

      const installed = readInstalledInfo(paths, name)

      // 安全交集快速路径：已装同版本且内容哈希一致 → 直接用已装实体，
      // 不复制进 store、不重复构建；最终决策仍由激活阶段的 InstallPlan 确认。
      if (installed && plugin.version && installed.version === plugin.version && plugin.sha256) {
        const installedHash = sha256OfDir(installed.dir)
        if (installedHash === plugin.sha256) {
          candidates.push({ name, dir: installed.dir, version: installed.version, sha256: installedHash, existed: true })
          step(`安全交集：已装同版本同内容 ${name}@${installed.version}，复用现有实体`)
          continue
        }
      }

      let absorbed
      try {
        // v2 先校验内容哈希，再吸收进 PluginStore；v1 无哈希直接吸收
        absorbed = absorbPlugin(paths, src, name, plugin.version, isV2 ? plugin.sha256 : undefined)
      } catch (error) {
        notes.push({ text: `插件内容校验/吸收失败: ${name}: ${messageOf(error)}`, level: 'error' })
        continue
      }

      try {
        if (absorbed.existed) {
          step(`PluginStore 交集去重: ${name}@${absorbed.version}（${absorbed.sha256.slice(0, 12)}… 已存在，复用实体）`)
        } else {
          step(`已吸收进 PluginStore: ${name}@${absorbed.version}（${absorbed.sha256.slice(0, 12)}…）`)
        }
        // 已装但版本/内容不同：不再构建（避免执行无关脚本），交给激活阶段裁决冲突；
        // 未装才走依赖 + 构建准备。
        if (installed) {
          notes.push({ text: `${name}: 已安装版本 ${installed.version || '未知'}，包内版本 ${absorbed.version}——将进入装配计划裁决（不静默覆盖）。`, level: 'warn' })
        } else {
          // 缺 lib 时按授权构建（与单插件安装同一安全策略）；失败只跳过该成员
          prepareDir(absorbed.dir, opts, step)
        }
        candidates.push({ name, dir: absorbed.dir, version: absorbed.version, sha256: absorbed.sha256, existed: absorbed.existed })
      } catch (error) {
        notes.push({ text: `插件包成员准备失败: ${name}: ${messageOf(error)}`, level: 'error' })
      }
    }
  }

  // 权威 dry-run 计划在 activatePrepared 阶段基于真实运行树构建；
  // 这里先把「已准备成功」的候选交给激活阶段，由它做交集裁决。
  const toActivate = candidates.map((candidate) => candidate.dir)
  return {
    kind: 'pack',
    name: 'pack:' + packPkg.name,
    dir: root,
    plugins: toActivate,
    presets: [],
    notes,
    pack: { groups, plugins: candidates },
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
 *
 * kind==='pack' 时先基于真实运行树构建权威 InstallPlan（dry-run），
 * 只激活 plan 裁决为 install 的插件；执行是包级事务：任一插件装配失败，
 * 本轮已成功装配的插件按逆序整体回滚。
 */
export async function activatePrepared(
  ctx: Context,
  paths: ResolvedPaths,
  prepared: Prepared,
  opts: InstallOptions = {},
): Promise<InstallResult[]> {
  const step = opts.onStep ?? (() => {})
  const results: InstallResult[] = []
  const activatedThisRun: Array<{ name: string; entryId?: string; dir: string }> = []

  // 插件包：权威 dry-run 计划（在吸收/准备完成之后，基于当前运行树构建）
  let plan = prepared.plan
  if (prepared.kind === 'pack') {
    const candidates = prepared.pack?.plugins ?? []
    plan = buildInstallPlan(ctx, paths, candidates)
    prepared.plan = plan
    step(`插件包装配计划（${plan.items.length} 个成员：安装 ${plan.toActivate.length} / 跳过 ${plan.items.filter((i) => i.decision === 'skip-installed').length} / 冲突 ${plan.items.filter((i) => i.decision === 'conflict').length}）`)
    for (const item of plan.items) {
      step(`[${item.decision}] ${item.identity.name}@${item.identity.version}: ${item.reason}`, item.level)
      if (item.decision === 'skip-installed') {
        results.push({ name: item.identity.name, entryId: '', dir: item.dir, message: item.reason })
      } else if (item.decision === 'conflict') {
        results.push({ name: item.identity.name, entryId: '', dir: item.dir, message: `跳过：${item.reason}` })
      }
    }
    if (plan.allSkipped) {
      step('插件包没有需要装配的成员（全部已安装或存在冲突），激活阶段结束', 'warn')
    }
  }

  const activateDirs = prepared.kind === 'pack' ? (plan?.toActivate ?? []) : prepared.plugins

  for (const dir of activateDirs) {
    const pkg = readPkg(dir)
    // 单插件 / 套装仍保留按 name 的已装检查；插件包已由 plan 裁决
    if (prepared.kind !== 'pack' && isInstalled(paths, pkg.name)) {
      step(`已安装，跳过: ${pkg.name}`, 'warn')
      results.push({ name: pkg.name, entryId: '', dir, message: `「${pkg.name}」已在 bundles 中，跳过` })
      continue
    }

    // 尊重卸载意图：显式重新安装会清除旧 disabled 覆盖（不静默复活，也不永久阻断）
    if (readPatchDisabledIds(paths.patchPath).has(pkg.name)) {
      step(`清除旧 disabled 覆盖（显式重新安装）: ${pkg.name}`, 'warn')
      writePatchDisabled(paths.patchPath, pkg.name, false)
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
      activatedThisRun.push({ name: pkg.name, dir })
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
      // 包级事务回滚：当前失败项 + 本轮已成功的全部逆操作
      await rollbackActivated(ctx, paths, [{ name: pkg.name, dir }, ...activatedThisRun])
      throw new Error(`装配失败（已整体回滚本插件包）: ${messageOf(error)}`)
    }
    activatedThisRun.push({ name: pkg.name, entryId: String(entryId), dir })
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

/** 包级事务回滚：逆序卸载本轮已装配的插件，并清除 bundles / junction */
async function rollbackActivated(
  ctx: Context,
  paths: ResolvedPaths,
  installed: Array<{ name: string; entryId?: string; dir: string }>,
): Promise<void> {
  const loader = ctx.loader as Loader
  for (const item of [...installed].reverse()) {
    // loader.create 失败的当前项可能没有返回 entryId，但 entry id 就是我们请求的包名
    const id = item.entryId || item.name
    try {
      await loader.remove(id)
    } catch {
      // 移除失败（entry 可能不存在）不阻断后续清理
    }
    try {
      removeBundle(paths.packagePath, item.name)
    } catch {
      // 已移除则忽略
    }
    try {
      rmSync(join(paths.profileDir, 'node_modules', ...item.name.split('/')), { recursive: true, force: true })
    } catch {
      // 已删除则忽略
    }
  }
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
 * 把若干分组导出为 DSH 插件包 v2（.tgz）：
 *   package.json（合成元数据，供 M2 识别）
 *   manifest.yml（分组 + 插件清单 + version + sha256，导入时校验）
 *   plugins/<包名>/（插件目录本体，排除 node_modules/.git）
 *
 * 同一插件出现在多个选中分组时只内嵌一份（seen 去重）；
 * manifest 中每个分组独立声明引用，因此交集是引用交集，不产生副本。
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
    // 先按插件名复制与哈希（每个实体只做一次），再让各分组声明引用。
    // 这就是交集处理在导出端的落地：物理内嵌去重，逻辑引用保留全集。
    const pluginEntries = new Map<string, { name: string; path: string; version: string; sha256: string }>()
    for (const [pluginName, sourceDir] of pluginDirs) {
      const target = join(pluginsStage, ...pluginName.split('/'))
      copyTreeExclude(sourceDir, target)
      pluginEntries.set(pluginName, {
        name: pluginName,
        path: posixPath(join('plugins', ...pluginName.split('/'))),
        version: readVersion(sourceDir) ?? '0.0.0-unknown',
        sha256: sha256OfDir(target),
      })
    }
    const manifestGroups: PackGroup[] = activeGroups.map((group) => ({
      name: group.name,
      desired: group.desired,
      plugins: group.plugins.map((pluginName) => ({ ...pluginEntries.get(pluginName)! })),
    }))

    const pkgJson = {
      name: safeName,
      version: '1.0.0',
      private: true,
      description: `DSH 插件包：${activeGroups.map((g) => g.name).join('、')}（由插件管理导出）`,
      dsh: {
        pack: {
          format: 'dsh-plugin-pack@2',
          manifest: 'manifest.yml',
        },
      },
    }
    const manifest = {
      pack: {
        name: safeName,
        version: '2.0.0',
        format: 'dsh-plugin-pack@2',
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
