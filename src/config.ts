import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export interface Config {
  /** profile 名（缺省 web） */
  profile: string
  /** DSH_HOME；空 = 自动探测 */
  home: string
}

export const Config = z.object({
  profile: z.string().default('web'),
  home: z.string().default(''),
})

/** 解析后的持久层路径（profile 的 package.json / cordis.patch.yml / pending 记录） */
export interface ResolvedPaths {
  home: string
  profile: string
  profileDir: string
  packagePath: string
  patchPath: string
  pendingPath: string
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
  }
}
