import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { PluginManageService } from './service.js'
import { cleanupExport } from './installer.js'

export const API_PREFIX = '/plugin-manage/api'

const MAX_BODY_BYTES = 128 * 1024 * 1024

type Logger = { info?(msg: string): void; warn?(msg: string): void }

async function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.from(chunk)
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large (max 128 MiB)')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

async function readBody(req: IncomingMessage): Promise<string> {
  return (await readBodyBuffer(req)).toString('utf8')
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 注册 client→host HTTP API（webServer prefix 路由）。
 * webServer 不可用时静默跳过——持久化读写主路径不依赖 GUI。
 */
export function registerGateway(ctx: Context, svc: PluginManageService, log?: Logger): void {
  let webServer: { register(route: unknown): () => void } | undefined
  try {
    const ws = (ctx as unknown as { get?: (name: string) => unknown }).get?.('webServer')
    if (ws && typeof (ws as { register?: unknown }).register === 'function') {
      webServer = ws as { register(route: unknown): () => void }
    }
  } catch {
    webServer = undefined
  }
  if (!webServer) {
    log?.warn?.('webServer 服务不可用，跳过插件管理 API 注册')
    return
  }

  const parseJson = async <T,>(req: IncomingMessage): Promise<T> => {
    const text = (await readBody(req)).trim()
    if (!text) throw new Error('缺少请求体')
    return JSON.parse(text) as T
  }

  const parseId = async (req: IncomingMessage): Promise<string> => {
    const text = (await readBody(req)).trim()
    if (!text) throw new Error('缺少请求体')
    const body = JSON.parse(text) as { id?: unknown }
    const id = String(body?.id ?? '').trim()
    if (!id) throw new Error('id 必填')
    return id
  }

  try {
    const disposer = webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const path = new URL(req.url ?? '/', 'http://localhost').pathname
            .replace(API_PREFIX, '')
            .replace(/\/+$/, '') || '/'
          if (req.method === 'GET' && path === '/list') {
            return send(res, 200, { ok: true, ...svc.list() })
          }
          if (req.method === 'GET' && path === '/install-tasks') {
            return send(res, 200, { ok: true, tasks: svc.listTasks() })
          }
          if (req.method === 'GET' && path === '/groups') {
            return send(res, 200, { ok: true, groups: svc.listGroups() })
          }
          if (req.method === 'POST' && path === '/groups/upsert') {
            const body = await parseJson<{ name?: unknown; desired?: unknown; plugins?: unknown }>(req)
            const name = String(body?.name ?? '').trim()
            if (!name) return send(res, 400, { ok: false, error: '分组名必填' })
            const desired = body?.desired === 'enabled' || body?.desired === 'disabled' ? body.desired : 'as-is'
            const plugins = Array.isArray(body?.plugins)
              ? body.plugins.map((p) => String(p).trim()).filter(Boolean)
              : []
            return send(res, 200, { ok: true, groups: svc.upsertGroup(name, desired, plugins) })
          }
          if (req.method === 'POST' && path === '/groups/delete') {
            const body = await parseJson<{ name?: unknown }>(req)
            const name = String(body?.name ?? '').trim()
            if (!name) return send(res, 400, { ok: false, error: '分组名必填' })
            return send(res, 200, { ok: true, groups: svc.deleteGroup(name) })
          }
          if (req.method === 'POST' && path === '/groups/apply') {
            const body = await parseJson<{ name?: unknown; op?: unknown }>(req)
            const name = String(body?.name ?? '').trim()
            const op = body?.op === 'enable' ? 'enable' : body?.op === 'disable' ? 'disable' : ''
            if (!name || !op) return send(res, 400, { ok: false, error: 'name 与 op(enable|disable) 必填' })
            return send(res, 200, { ok: true, result: await svc.applyGroup(name, op) })
          }
          if (req.method === 'POST' && path === '/update') {
            return send(res, 200, { ok: true, result: svc.update(await parseId(req)) })
          }
          if (req.method === 'POST' && path === '/delegate-ai') {
            const body = await parseJson<{ taskId?: unknown }>(req)
            const taskId = Number(body?.taskId)
            if (!Number.isInteger(taskId) || taskId <= 0) {
              return send(res, 400, { ok: false, error: 'taskId 必填' })
            }
            return send(res, 200, { ok: true, result: await svc.delegateAi(taskId) })
          }
          if (req.method === 'GET' && path === '/export-pack') {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const packName = url.searchParams.get('name') || 'dsh-plugin-pack'
            const groupNames = (url.searchParams.get('groups') || '').split(',').map((x) => x.trim()).filter(Boolean)
            const exported = await svc.exportPack(packName, groupNames)
            const filePath = exported.filePath
            if (!existsSync(filePath)) throw new Error('导出文件不存在: ' + filePath)
            const size = statSync(filePath).size
            res.writeHead(200, {
              'content-type': 'application/gzip',
              'content-length': String(size),
              'content-disposition': `attachment; filename="${exported.fileName}"`,
            })
            const stream = createReadStream(filePath)
            stream.on('error', () => {
              try { res.destroy() } catch { /* ignore */ }
            })
            stream.on('close', () => {
              try { cleanupExport(filePath) } catch { /* ignore */ }
            })
            stream.pipe(res)
            return
          }
          if (req.method === 'POST' && path === '/disable') {
            return send(res, 200, { ok: true, result: await svc.disable(await parseId(req)) })
          }
          if (req.method === 'POST' && path === '/enable') {
            return send(res, 200, { ok: true, result: await svc.enable(await parseId(req)) })
          }
          if (req.method === 'POST' && path === '/uninstall') {
            return send(res, 200, { ok: true, result: await svc.uninstall(await parseId(req)) })
          }
          if (req.method === 'POST' && path === '/cancel-uninstall') {
            return send(res, 200, { ok: true, result: await svc.cancelUninstall(await parseId(req)) })
          }
          if (req.method === 'POST' && path === '/install-local') {
            const text = (await readBody(req)).trim()
            if (!text) return send(res, 400, { ok: false, error: '缺少路径' })
            const body = JSON.parse(text) as { path?: unknown; allowBuild?: unknown }
            const dir = String(body?.path ?? '').trim()
            if (!dir) return send(res, 400, { ok: false, error: 'path 必填' })
            return send(res, 200, { ok: true, result: svc.installLocal(dir, { allowBuild: body.allowBuild === true }) })
          }
          if (req.method === 'POST' && path === '/install-tgz') {
            const fileName = String(req.headers['x-file-name'] ?? 'plugin.tgz').trim()
            const allowBuild = String(req.headers['x-allow-build'] ?? '') === 'true'
            const buffer = await readBodyBuffer(req)
            if (!buffer.length) return send(res, 400, { ok: false, error: '缺少文件内容' })
            return send(res, 200, { ok: true, result: svc.installTgz(fileName, buffer, { allowBuild }) })
          }
          if (req.method === 'POST' && path === '/install-source') {
            const text = (await readBody(req)).trim()
            if (!text) return send(res, 400, { ok: false, error: '缺少地址或指令' })
            const body = JSON.parse(text) as { source?: unknown; allowBuild?: unknown }
            const source = String(body?.source ?? '').trim()
            if (!source) return send(res, 400, { ok: false, error: 'source 必填' })
            return send(res, 200, { ok: true, result: svc.installSource(source, { allowBuild: body.allowBuild === true }) })
          }
          return send(res, 404, { ok: false, error: 'not found: ' + path })
        } catch (error) {
          return send(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    })
    ctx.effect(() => disposer, 'plugin-manage: api')
  } catch (error) {
    log?.warn?.('webServer.register 失败: ' + String(error))
  }
}
