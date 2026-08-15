/**
 * 安装任务队列：准备阶段并行（默认 3 路），激活阶段串行。
 * 任务步骤实时记录在内存，供 UI 轮询展示。
 */
import type { InstallResult } from './installer.js'

export type InstallKind = 'local' | 'tgz' | 'source' | 'update'

export interface TaskStep {
  ts: number
  text: string
  level: 'info' | 'ok' | 'warn' | 'error'
}

export type TaskStatus = 'queued' | 'running' | 'success' | 'failed'

export interface InstallTask {
  id: number
  kind: InstallKind
  label: string
  status: TaskStatus
  /** 0-100，按阶段推进；失败停留在失败时进度 */
  progress: number
  steps: TaskStep[]
  result?: InstallResult[]
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

export interface TaskContext {
  step(text: string, level?: TaskStep['level']): void
  progress(value: number): void
  /** 激活阶段走串行链：并发任务会在这里排队，避免互相踩 profile 配置 */
  finalize<T>(fn: () => Promise<T>): Promise<T>
}

const MAX_PARALLEL = 3
const MAX_HISTORY = 40

export class InstallQueue {
  private tasks = new Map<number, InstallTask>()
  private executors = new Map<number, (t: TaskContext) => Promise<InstallResult[]>>()
  private order: number[] = []
  private queued: number[] = []
  private running = 0
  private finalizeChain: Promise<unknown> = Promise.resolve()
  private nextId = 1

  constructor(private maxParallel = MAX_PARALLEL) {}

  enqueue(kind: InstallKind, label: string, exec: (t: TaskContext) => Promise<InstallResult[]>): InstallTask {
    const task: InstallTask = {
      id: this.nextId++,
      kind,
      label,
      status: 'queued',
      progress: 0,
      steps: [],
      createdAt: Date.now(),
    }
    this.tasks.set(task.id, task)
    this.executors.set(task.id, exec)
    this.order.push(task.id)
    this.queued.push(task.id)
    this.trimHistory()
    this.pump()
    return task
  }

  /** 全量快照（活跃在前，历史按时间倒序） */
  snapshot(): InstallTask[] {
    return this.order
      .map((id) => this.tasks.get(id)!)
      .sort((a, b) => {
        const rank = (t: InstallTask) => (t.status === 'queued' || t.status === 'running' ? 0 : 1)
        return rank(a) - rank(b) || b.createdAt - a.createdAt
      })
  }

  private pump(): void {
    while (this.running < this.maxParallel && this.queued.length) {
      const id = this.queued.shift()!
      void this.run(id)
    }
  }

  private async run(id: number): Promise<void> {
    const task = this.tasks.get(id)!
    const exec = this.executors.get(id)!
    task.status = 'running'
    task.startedAt = Date.now()
    this.running++
    const ctx: TaskContext = {
      step: (text, level = 'info') => {
        task.steps.push({ ts: Date.now(), text, level })
      },
      progress: (value: number) => {
        task.progress = Math.max(0, Math.min(100, Math.round(value)))
      },
      finalize: <T,>(fn: () => Promise<T>): Promise<T> => {
        const next = this.finalizeChain.then(fn, fn)
        this.finalizeChain = next.catch(() => {})
        return next
      },
    }
    try {
      const result = await exec(ctx)
      task.result = result
      task.status = 'success'
    } catch (error) {
      task.status = 'failed'
      task.error = error instanceof Error ? error.message : String(error)
      ctx.step(task.error, 'error')
    } finally {
      this.executors.delete(id)
      task.finishedAt = Date.now()
      this.running--
      this.trimHistory()
      this.pump()
    }
  }

  private trimHistory(): void {
    while (this.order.length > MAX_HISTORY) {
      const oldest = this.order.shift()!
      if (!this.queued.includes(oldest) && this.tasks.get(oldest)?.status !== 'running') {
        this.tasks.delete(oldest)
      }
    }
  }
}
