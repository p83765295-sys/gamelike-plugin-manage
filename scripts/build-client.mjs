// build:client — 把手写的 browser half（vision-router 式零构建 bundle）复制为 lib/client.js。
// 不依赖 tsdown/rolldown（本机 rolldown 原生二进制 SIGBUS 不可用）。
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(root, 'lib'), { recursive: true })
copyFileSync(join(root, 'src/client/bundle.js'), join(root, 'lib/client.js'))
console.log('client bundle → lib/client.js')
