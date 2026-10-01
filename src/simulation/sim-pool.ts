import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import os from 'node:os';
import type { SimulationInput, SimulationResult } from '../types.js';
import {
  SimAbortedError,
  SimBusyError,
  SimFailedError,
  type SimJob,
} from './errors.js';

/**
 * 专用 worker 线程消息（见 sim-worker.js）
 */
type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: number; result: SimulationResult }
  | { type: 'error'; id: number; message: string };

interface PoolWorker {
  worker: Worker;
  /** 正在执行的作业；空闲为 null */
  current: SimJob | null;
  /** worker 启动到收到首个 ready 前不算就绪 */
  ready: boolean;
  /** 已被主动终止/回收，exit 事件不再补员、不再回调 */
  dead: boolean;
}

export interface SimPoolOptions {
  /** 并发 worker 上限（超出进等待队列），默认取可用 CPU 数，夹在 [1, 4] */
  size?: number;
  /** 等待队列长度上限，超出直接回 503，默认 64 */
  queueLimit?: number;
  /** 全员空闲多久后回收线程（ms），默认 1500 */
  idleTtlMs?: number;
}

export interface SimPoolStats {
  /** worker 总数 */
  poolSize: number;
  /** 正在执行的作业数 */
  active: number;
  /** 就绪空闲 worker 数 */
  idle: number;
  /** 等待队列长度 */
  queued: number;
  /** 队列容量 */
  queueLimit: number;
}

/**
 * 找到 worker 入口与引擎模块的真实路径。
 * dist（生产）下两者都是 .js；src（tsx 开发/测试）下 worker 仍是这个 .js
 * 文件，引擎则是 .ts，需要 worker 内注册 tsx 加载器。
 */
function resolveWorkerEntry(): { entry: URL; enginePath: string; registerTsx: boolean } {
  const entry = new URL('./sim-worker.js', import.meta.url);
  const compiledEngine = fileURLToPath(new URL('./engine.js', import.meta.url));
  if (existsSync(compiledEngine)) {
    return { entry, enginePath: compiledEngine, registerTsx: false };
  }
  return {
    entry,
    enginePath: fileURLToPath(new URL('./engine.ts', import.meta.url)),
    registerTsx: true,
  };
}

function defaultPoolSize(): number {
  const cpus = Math.max(1, os.availableParallelism());
  return Math.min(4, cpus);
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/**
 * 按需启动、空闲回收的仿真 worker 池。
 *
 * - worker 懒启动：首请求到达才建线程，并发请求数决定开几个，上限 size；
 * - 所有长计算都在独立线程，主事件循环只负责校验与转发，健康检查和解析
 *   请求不再被仿真拖住；多 worker 在多核上真并行；
 * - 调用方放弃时直接 terminate 对应 worker（硬中断），已投入 CPU 立刻释放；
 *   线程从池移除，队列若还有作业由 pump 按需拉起新线程，槽位不被占掉；
 * - 全员空闲超过 idleTtlMs 后整池回收：tsx 加载器在 worker 内注册时会留下
 *   保活的消息端口，只有终止线程才能释放，因此测试/一次性脚本可以自然退出；
 *   看门狗定时器本身 unref，绝不由它保活。真实服务有 listen 句柄常驻，
 *   回收后下一个请求会自动重建线程（代价仅是一次冷启动）；
 * - 槽位与等待队列都满时快速失败（503 SIMULATION_BUSY）。
 */
export class SimulationPool {
  private readonly pool: PoolWorker[] = [];
  private readonly queue: SimJob[] = [];
  private readonly maxSize: number;
  private readonly queueLimit: number;
  private readonly idleTtlMs: number;
  private readonly entry: { entry: URL; enginePath: string; registerTsx: boolean };
  private nextJobId = 1;
  private idleTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(options: SimPoolOptions = {}) {
    this.maxSize = options.size ?? positiveInt(process.env.SIM_CONCURRENCY, defaultPoolSize());
    this.queueLimit =
      options.queueLimit ?? positiveInt(process.env.SIM_QUEUE_LIMIT, 64);
    this.idleTtlMs = options.idleTtlMs ?? 1500;
    this.entry = resolveWorkerEntry();
  }

  private spawn(): PoolWorker {
    const worker = new Worker(this.entry.entry, {
      workerData: {
        enginePath: this.entry.enginePath,
        registerTsx: this.entry.registerTsx,
      },
    });
    // 双保险：生产（无 tsx 残留端口）下空闲 worker 不阻止进程退出；
    // 开发/测试下额外由空闲看门狗回收
    worker.unref();
    const slot: PoolWorker = { worker, current: null, ready: false, dead: false };

    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'ready') {
        slot.ready = true;
        this.pump();
        return;
      }
      const job = slot.current;
      slot.current = null;
      if (job && job.id === message.id) {
        if (message.type === 'result') {
          job.resolve(message.result);
        } else {
          job.reject(new SimFailedError(message.message));
        }
      }
      // 作业完成：继续派发队列，并在彻底空闲后排回收
      this.pump();
      this.scheduleReapIfIdle();
    });

    worker.on('error', (error) => {
      // 线程级故障不能让进程挂掉：在途作业失败（结构化 500），线程移除，
      // 队列若还有作业由 pump 按需补员
      const job = slot.current;
      slot.current = null;
      this.remove(slot);
      if (job) {
        job.reject(
          new SimFailedError(error instanceof Error ? error.message : String(error)),
        );
      }
      this.pump();
      this.scheduleReapIfIdle();
    });

    worker.on('exit', (code) => {
      const job = slot.current;
      slot.current = null;
      this.remove(slot);
      // 主动 terminate（取消/回收/关停）走 dead 分支，不补员、不回调；
      // 非预期退出（code !== 1）让在途作业失败
      if (!slot.dead && job) {
        job.reject(new SimFailedError(`工作线程异常退出（code=${code}）`));
      }
      this.pump();
      this.scheduleReapIfIdle();
    });

    return slot;
  }

  /** 从活动池移除已终止的线程（幂等） */
  private remove(slot: PoolWorker): void {
    const index = this.pool.indexOf(slot);
    if (index !== -1) this.pool.splice(index, 1);
  }

  /** 队列里还有作业且线程数没到上限时补线程 */
  private ensureCapacity(): void {
    while (this.queue.length > 0 && this.pool.length < this.maxSize) {
      this.pool.push(this.spawn());
    }
  }

  /** 把等待队列里的作业派发给就绪且空闲的 worker */
  private pump(): void {
    if (this.shuttingDown) return;
    this.ensureCapacity();
    while (this.queue.length > 0) {
      const slot = this.pool.find((w) => w.ready && w.current === null && !w.dead);
      if (!slot) return; // 剩余 worker 还在启动，ready 后会再次 pump
      const job = this.queue.shift() as SimJob;
      slot.current = job;
      // 有活干了，取消待执行的空闲回收
      if (this.idleTimer !== null) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      slot.worker.postMessage({ id: job.id, input: job.input });
    }
  }

  /** 全部 worker 空闲且队列空时，安排一次性回收；定时器 unref，不保活进程 */
  private scheduleReapIfIdle(): void {
    if (this.shuttingDown) return;
    if (this.idleTimer !== null) return;
    if (this.queue.length > 0 || this.pool.some((w) => w.current !== null)) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (
        this.shuttingDown ||
        this.queue.length > 0 ||
        this.pool.some((w) => w.current !== null)
      ) {
        return;
      }
      this.reapAll();
    }, this.idleTtlMs);
    this.idleTimer.unref();
  }

  /** 终止并清空全部空闲 worker；下一个请求到来时懒重建 */
  private reapAll(): void {
    const slots = this.pool.splice(0, this.pool.length);
    for (const slot of slots) {
      slot.dead = true;
      slot.worker.terminate().catch(() => {});
    }
  }

  /** 在途作业数（正在跑 + 排队中） */
  private inFlight(): number {
    return this.pool.reduce((n, w) => n + (w.current ? 1 : 0), 0) + this.queue.length;
  }

  /**
   * 提交一次仿真。返回 Promise：
   * - 正常完成 resolve 结果（与同输入在进程内直跑逐位相同）；
   * - 调用方 abort 时 reject SimAbortedError，计算被硬中断；
   * - 并发+排队容量用尽 reject SimBusyError（400 校验在路由层、入池前完成）。
   */
  run(input: SimulationInput, signal?: AbortSignal): Promise<SimulationResult> {
    if (this.shuttingDown) {
      return Promise.reject(new SimBusyError('服务正在关闭，不再接受仿真请求'));
    }
    // 容量 = 并发上限 + 等待队列；本次新作业占一个名额
    if (this.inFlight() >= this.maxSize + this.queueLimit) {
      return Promise.reject(new SimBusyError());
    }

    return new Promise<SimulationResult>((resolve, reject) => {
      let settled = false;
      const job: SimJob = {
        id: this.nextJobId++,
        input,
        resolve,
        reject,
      };

      const onAbort = () => {
        // 作业已经落定（正常完成/失败）后，旧 controller 再触发 abort
        // （例如 keep-alive 连接复用后的 res close）必须变成无操作，绝不能
        // 误杀后来占用同一线程的无关作业
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        // 情况一：还在等待队列里，直接摘掉，线程根本不会开工
        const queuedIndex = this.queue.indexOf(job);
        if (queuedIndex !== -1) {
          this.queue.splice(queuedIndex, 1);
          reject(new SimAbortedError());
          this.scheduleReapIfIdle();
          return;
        }
        // 情况二：已经在线程上跑——终止该线程，硬中断计算；不在这里补员，
        // 队列若还有作业，pump 会按需拉起新线程
        const slot = this.pool.find((w) => w.current === job);
        if (slot) {
          slot.current = null;
          slot.dead = true;
          slot.worker.terminate().catch(() => {});
          this.remove(slot);
        }
        reject(new SimAbortedError());
        this.pump();
        this.scheduleReapIfIdle();
      };
      // 作业无论成败都落定并摘除 abort 监听，防止连接后续 close 误伤无关作业
      const onSettled = () => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        return true;
      };
      job.resolve = (value: SimulationResult) => {
        if (onSettled()) resolve(value);
      };
      job.reject = (error: unknown) => {
        if (onSettled()) reject(error);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.queue.push(job);
      this.pump();
    });
  }

  stats(): SimPoolStats {
    const active = this.pool.reduce((n, w) => n + (w.current ? 1 : 0), 0);
    return {
      poolSize: this.pool.length,
      active,
      idle: this.pool.filter((w) => w.ready && w.current === null && !w.dead).length,
      queued: this.queue.length,
      queueLimit: this.queueLimit,
    };
  }

  /** 关停服务时结束全部线程（不等待在途作业） */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const job of this.queue.splice(0)) {
      job.reject(new SimAbortedError('服务关闭'));
    }
    const slots = this.pool.splice(0, this.pool.length);
    await Promise.all(
      slots.map(async (slot) => {
        slot.dead = true;
        slot.current = null;
        await slot.worker.terminate().catch(() => {});
      }),
    );
  }
}

/** 路由层共享的单例池 */
let sharedPool: SimulationPool | null = null;

export function getSimulationPool(): SimulationPool {
  if (!sharedPool) sharedPool = new SimulationPool();
  return sharedPool;
}
