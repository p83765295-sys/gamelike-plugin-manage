import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export interface Config {
  /** profile 名（缺省 web） */
  profile: string
  /** DSH_HOME；空 = 自动探测 */
  home: string
  /** 是否允许插件触发 DSH 自重启（supervisor 托管部署应设为 false） */
  allowRestart: boolean
}

export const Config = z.object({
  profile: z.string().default('web'),
  home: z.string().default(''),
  allowRestart: z.boolean().default(true),
})

/** 解析后的持久层路径（profile 的 package.json / cordis.patch.yml / pending 记录） */
export interface ResolvedPaths {
  home: string
  profile: string
  profileDir: string
  packagePath: string
  patchPath: string
  pendingPath: string
  /** M2 解包/克隆根：必须在 .dsh 之外（DSH loader 对 .dsh 路径的依赖解析有限制） */
  pluginsDir: string
  /** M4 插件分组持久化 */
  groupsPath: string
  /** M2/M1 「交给 AI 配置」降级请求文件 */
  aiRequestPath: string
}

export function resolvePaths(config: Config): ResolvedPaths {
  const home = config.home || resolveDshHome()
  const profileDir = join(home, 'profiles', config.profile)
  return {
    home,
    profile: config.profile,
    profileDir,
    packagePath: join(profileDir, 'package.json'),
    patchPath: join(profileDir, 'cordis.patch.yml'),
    pendingPath: join(home, 'plugin-manage.pending.json'),
    pluginsDir: join(dirname(home), 'dsh-plugins'),
    groupsPath: join(home, 'plugin-manage-groups.yml'),
    aiRequestPath: join(home, 'plugin-manage.ai-config-request.json'),
  }
}
