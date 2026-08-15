// Build gamelike-plugin-manage: compile src/ → lib/ with local tsc.
// 跨平台（Windows / macOS / Linux / WSL）。依赖从已安装的 @deepseek-ai/dsh
// 树中 junction/symlink 过来；运行时依赖 yaml/tar 由 npm install 提供。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  } catch (error) {
    const e = error
    throw new Error(`${cmd} ${args.join(' ')} 失败: ${e.stderr || e.message || error}`)
  }
}

// ── DSH 安装树探测：env → 已知全局路径 → npm root -g 推导 ──
function locateDsh() {
  const candidates = []
  if (process.env.DSH_CHECKOUT) candidates.push(process.env.DSH_CHECKOUT)
  const isWin = process.platform === 'win32'
  if (isWin) {
    // Windows 常见 npm 全局安装位置
    if (process.env.APPDATA) {
      candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
    }
    candidates.push(join(process.cwd(), '..', '..', 'node_modules', '@deepseek-ai', 'dsh'))
  } else {
    candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh')
  }
  try {
    const globalRoot = run(isWin ? 'npm.cmd' : 'npm', ['root', '-g']).trim()
    if (globalRoot) candidates.push(join(globalRoot, '@deepseek-ai', 'dsh'))
  } catch {
    // npm 不可用则跳过
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, 'node_modules', '@deepseek-ai', 'cordis'))) return candidate
  }
  throw new Error('build: cannot locate the dsh install (set DSH_CHECKOUT)')
}

const checkout = locateDsh()
console.log('=== Linking build dependencies (checkout: ' + checkout + ') ===')

function linkPkg(pkgName, relTarget) {
  const link = join(root, 'node_modules', pkgName)
  const target = join(checkout, 'node_modules', relTarget)
  if (!existsSync(target)) {
    throw new Error(`build: dependency target missing: ${target}`)
  }
  rmSync(link, { recursive: true, force: true })
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

mkdirSync(join(root, 'node_modules', '@deepseek-ai'), { recursive: true })
linkPkg('@deepseek-ai/cordis', '@deepseek-ai/cordis')
linkPkg('cosmokit', '@deepseek-ai/cosmokit')
linkPkg('@deepseek-ai/schemastery', '@deepseek-ai/schemastery')
linkPkg('@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-loader')
linkPkg('@deepseek-ai/dsh-home-paths', '@deepseek-ai/dsh-home-paths')

console.log('=== Compiling src → lib ===')
// 直接用 typescript 包的 tsc.js，避免依赖 node_modules/.bin/tsc(.cmd) 的跨平台差异
const tscJs = join(root, 'node_modules', 'typescript', 'lib', 'tsc.js')
if (!existsSync(tscJs)) {
  throw new Error('build: typescript not found — run: npm install --include=dev')
}
run(process.execPath, [tscJs, '-p', 'tsconfig.json'])
console.log('=== Build complete ===')
