/**
 * gamelike-plugin-manage — 插件管理（设置 → 插件管理）。
 *
 * M1 管理插件：列出 loader 树全部插件（官方 / 用户 / 临时注入），
 * 原生插件只允许禁用/启用，用户插件允许禁用/启用/卸载。
 * 操作先只写 pending 记录，当前进程完全不动；重启后本插件 apply 时
 * 再把 pending 真正写入 cordis.patch.yml / package.json（原生禁用重启后不恢复）。
 * 因此卸载在重启前可随时取消（pending 一删，配置从未被动过）。
 * M2 插件安装 / M3 开发插件占位 / M4 插件包：
 * 分组多归属；插件包 v2 以 (name, version, sha256) 为身份，
 * 导入时校验哈希 → 吸收进 PluginStore → InstallPlan 交集裁决 → 包级事务装配。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { Config, resolvePaths, type Config as ConfigType } from './config.js'
import { registerGateway } from './gateway.js'
import { createService } from './service.js'

export const name = 'gamelike-plugin-manage'

/**
 * loader：只读投影运行树。
 * webServer：硬依赖 —— 必须等 webServer 服务就绪后再 apply，
 * 否则 API 注册会被跳过（页面拿到 HTML → JSON 解析失败）。
 * timer：重启后延迟执行 pending 应用（等装配稳定后再写配置）。
 */
export const inject = ['loader', 'webServer', 'timer']

type AppContext = Context & { loader: Loader; timeout(fn: () => void, ms: number): () => void }

export function apply(ctx: AppContext, config: ConfigType): void {
  const paths = resolvePaths(config)
  const log = (msg: string): void => {
    try {
      ;(ctx as unknown as { logger?: (name: string) => { info?(msg: string): void } }).logger?.('plugin-manage')?.info?.(msg)
    } catch {
      // logger 不可用时静默
    }
  }

  const svc = createService(ctx, paths)
  ctx.provide('pluginManage', svc)
  registerGateway(ctx, svc, { warn: (msg) => log(msg) })

  // 重启后 2 秒应用 pending：装配稳定后再真正写 patch/package.json。
  // include 会热应用这些配置，从而让「重启后生效」在重启后真正落地。
  ctx.timeout(() => {
    void svc.applyPending()
  }, 2000)

  log(`插件管理启动: profile=${paths.profile} patch=${paths.patchPath}`)
}

export { Config }
