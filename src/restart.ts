/**
 * DSH 进程自重启（独立重写实现）。
 *
 * 设计灵感来自 dsh-market 的 restart 流程（MIT License，
 * Copyright (c) 2026 fkysly and dsh-market contributors）。本文件
 * 未复制其代码，仅采纳其公开验证过的行为设计：
 *   - 精确重放启动本进程的 DSH 命令（含 execArgv / argv / cwd）
 *   - 用 detached 的 Node 小助手延迟拉起新进程，等旧进程释放端口
 *   - Windows 下通过 PowerShell -WindowStyle Hidden 包装，避免
 *     detached 进程无 console 导致后续子进程弹出可见窗口
 *   - supervisor（systemd/pm2/launchd）托管场景由 allowRestart=false 关闭
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export interface RestartLaunch {
  file: string
  args: string[]
  cwd?: string
  viaShell: boolean
}

export interface RespawnInvocation {
  file: string
  args: string[]
  viaShell: boolean
  detached: boolean
}

/** 探测启动本 DSH 进程的入口与参数。 */
export function restartLaunch(): RestartLaunch {
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    // 源码 / bin 入口：必须用绝对路径，避免子进程按自己的 cwd 解析失败。
    const abs = resolve(entry)
    return {
      file: process.execPath,
      args: [...process.execArgv, abs, ...process.argv.slice(2)],
      cwd: dirname(abs),
      viaShell: false,
    }
  }
  // npm 全局 dsh 命令；Windows 的 .cmd shim 需要 shell 启动。
  return {
    file: 'dsh',
    args: [...process.argv.slice(2)],
    cwd: process.cwd(),
    viaShell: process.platform === 'win32',
  }
}

/** 平台正确的拉起方式：POSIX 用 detached；Windows 用隐藏窗口的 PowerShell。 */
export function respawnInvocation(launch: RestartLaunch, platform: NodeJS.Platform = process.platform): RespawnInvocation {
  if (platform !== 'win32') {
    return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true }
  }
  const quote = (part: string): string => `'${part.replace(/'/g, "''")}'`
  return {
    file: 'powershell.exe',
    args: [
      '-NoProfile',
      '-WindowStyle',
      'Hidden',
      '-Command',
      [`& ${quote(launch.file)}`, ...launch.args.map(quote)].join(' '),
    ],
    viaShell: false,
    detached: false,
  }
}

export interface ScheduledRestart {
  pid: number
  helperPid: number | undefined
  logOut: string
  logErr: string
}

/**
 * 调度自重启：detached helper 延迟 1.5s 拉起新 DSH，当前进程 0.5s 后退出。
 * helper 的 stdout/stderr 写入 tmpdir 下的日志文件，便于排查重启失败。
 */
export function scheduleRestart(): ScheduledRestart {
  const launch = restartLaunch()
  const spawned = respawnInvocation(launch)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logOut = join(tmpdir(), `plugin-manage-restart-${stamp}.out.log`)
  const logErr = join(tmpdir(), `plugin-manage-restart-${stamp}.err.log`)
  const helperCode = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const file = ${JSON.stringify(spawned.file)}`,
    `const args = ${JSON.stringify(spawned.args)}`,
    `const cwd = ${JSON.stringify(launch.cwd ?? process.cwd())}`,
    `const viaShell = ${JSON.stringify(spawned.viaShell)}`,
    `const detached = ${JSON.stringify(spawned.detached)}`,
    `const logOut = ${JSON.stringify(logOut)}`,
    `const logErr = ${JSON.stringify(logErr)}`,
    'setTimeout(() => {',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    '    const child = spawn(file, args, { cwd, detached, stdio: ["ignore", out, err], env: process.env, shell: viaShell })',
    '    child.unref()',
    '  } catch {}',
    '}, 1500)',
  ].join('\n')
  const helper = spawn(process.execPath, ['-e', helperCode], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  helper.unref()
  setTimeout(() => {
    try {
      process.kill(process.pid, 'SIGTERM')
    } catch {
      // 进程可能已经退出
    }
  }, 500)
  return { pid: process.pid, helperPid: helper.pid, logOut, logErr }
}
