import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type { SimulationInput, SimulationResult } from '../types.js';
import type { WorkerResponse } from './worker-protocol.js';

/**
 * 仿真计算为什么必须放进独立执行单元：
 *
 * Node 单线程事件循环里，原来的 runSimulation 是一段 7 秒级的同步热循环，
 * 循环期间事件循环完全得不到调度，健康检查、解析请求、对照请求只能在后面
 * 排队；调用方断开连接也无人感知。这里把仿真放到固定数量的 worker 线程中
 * 并行执行，主线程只负责收发 HTTP 与调度作业，因此：
 *
 * - 长仿真在 worker 里跑时，主线程仍能在毫秒级应答 /health 与 /api/analytic；
 * - 多组长仿真由不同 worker 真并行处理（受并发上限约束），不再首尾相接；
 * - 客户端断开后，主线程立刻给对应 worker 发取消信号，worker 在分片边界
 *   停下（见 sim-worker.ts），不再继续空耗 CPU；
 * - 计算被取消或失败时 reject，路由层绝不会把“半截结果”当正常响应返回。
 *
 * 为什么不用“只在主线程分段 setImmediate 让出”的方案：那只能解决健康检查
 * 被饿死的问题，两个长仿真依旧在同一线程里瓜分时间片，总墙钟时间仍是
 * 二者之和，对照接口两单齐发的现象无法消除，所以选择了 worker 并行；
 * worker 内部同时保留分段让出，用于及时响应取消。
 */

/** 作业被主动放弃（调用方断开 / 正在关闭） */
export class SimulationAbortedError extends Error {
  readonly code = 'SIMULATION_ABORTED';
  constructor(message = '仿真计算已取消：调用方已断开连接') {
    super(message);
    this.name = 'SimulationAbortedError';
  }
}

/** worker 内部失败（输入非法在路由层已提前拦截，这里只兜底） */
export class SimulationFailedError extends Error {
  readonly code = 'SIMULATION_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'SimulationFailedError';
  }
}

interface Job {
  id: number;
  input: SimulationInput;
  signal: AbortSignal;
  worker: Worker | null;
  settled: boolean;
  resolve: (result: SimulationResult) => void;
  reject: (err: Error) => void;
}

/** 默认并发：最多 4 个仿真并行；可用 CPU 更少时相应下调，可用 SIM_WORKERS 覆盖 */
function defaultConcurrency(): number {
  const envMax = Number(process.env.SIM_WORKERS ?? '');
  if (Number.isInteger(envMax) && envMax >= 1) return envMax;
  let cpus = 4;
  try {
    cpus = availableParallelism();
  } catch {
    // 老版本接口缺失时退回 4
  }
  return Math.max(1, Math.min(4, cpus));
}

/**
 * 构造 worker 引导脚本。
 *
 * 以“当前模块自身的扩展名”判断运行形态，而不是去探测磁盘上是否存在 dist：
 * 生产（`node dist/server.js`）里本模块是编译后的 .js，worker 同样直接
 * 动态 import 编译后的 sim-worker.js；开发 / 自动化测试经 tsx 直跑 .ts，
 * 本模块是 .ts，worker 也加载 sim-worker.ts。tsx 的 ESM 钩子不会自动传播进
 * worker 线程（直接 new Worker('xx.ts') 会报 Unknown file extension），因此
 * 在 worker 内用 tsx 提供的 tsImport 加载 TS 入口。两条路加载的是同一份
 * 仿真代码，结果语义没有差别。
 */
function buildBootstrap(): string {
  const workerJs = new URL('./sim-worker.js', import.meta.url);
  if (import.meta.url.endsWith('.js')) {
    return `await import(${JSON.stringify(workerJs.href)});`;
  }
  // 仅在源码直跑（tsx）模式下解析 tsx；生产镜像里 tsx 已被 prune，
  // 但此分支根本不会执行，不能在模块加载期无条件解析它。
  const workerTs = new URL('./sim-worker.ts', import.meta.url);
  // createRequire 对 'tsx/esm/api' 解析到的是 CJS 条件入口 index.cjs，
  // worker 内是 ESM 上下文，需要同目录的 ESM 入口 index.mjs。
  const cjsEntry = createRequire(import.meta.url).resolve('tsx/esm/api');
  const esmEntry = cjsEntry.replace(/[\\/]index\.cjs$/, '/index.mjs');
  if (!existsSync(esmEntry)) {
    throw new Error(`无法定位 tsx ESM 入口（解析到 ${cjsEntry}）`);
  }
  const tsxApi = pathToFileURL(esmEntry).href;
  return [
    `const { tsImport } = await import(${JSON.stringify(tsxApi)});`,
    `await tsImport(${JSON.stringify(workerTs.href)}, ${JSON.stringify(workerJs.href)});`,
  ].join('\n');
}

export class SimulationPool {
  private readonly slots: Array<Worker | null>;
  private readonly idle: Worker[] = [];
  private readonly queue: Job[] = [];
  private readonly running = new Map<Worker, Job>();
  private readonly bootstrap = buildBootstrap();
  private nextId = 1;
  private shuttingDown = false;

  constructor(private readonly concurrency = defaultConcurrency()) {
    this.slots = new Array<Worker | null>(concurrency).fill(null);
  }

  /** 当前存活 worker 数（含忙与闲） */
  private liveCount(): number {
    return this.slots.reduce((n, w) => (w ? n + 1 : n), 0);
  }

  /**
   * 提交一个仿真作业。signal 中止后：
   * - 还在排队：立即放弃并 reject aborted；
   * - 已在 worker 上执行：通知 worker 取消，worker 在当前分片结束后停下，
   *   同样 reject aborted，绝不返回部分结果。
   */
  run(input: SimulationInput, signal: AbortSignal): Promise<SimulationResult> {
    return new Promise<SimulationResult>((resolve, reject) => {
      if (this.shuttingDown) {
        reject(new SimulationFailedError('服务正在关闭，不再接受仿真作业'));
        return;
      }
      const job: Job = {
        id: this.nextId++,
        input,
        signal,
        worker: null,
        settled: false,
        resolve,
        reject,
      };
      if (signal.aborted) {
        reject(new SimulationAbortedError());
        return;
      }
      signal.addEventListener('abort', () => this.abortJob(job), { once: true });
      this.queue.push(job);
      this.schedule();
    });
  }

  /** 取消（或标记取消）一个作业，只会发生一次 settle */
  private abortJob(job: Job): void {
    if (job.settled) return;
    const queuedAt = this.queue.indexOf(job);
    if (queuedAt !== -1) {
      // 尚未开始计算：直接撤下，不占用任何 worker
      this.queue.splice(queuedAt, 1);
      this.settle(job, new SimulationAbortedError());
      return;
    }
    if (job.worker && this.running.get(job.worker) === job) {
      // 已在计算：让 worker 在分片边界停下；结果消息到达时统一 settle
      job.worker.postMessage({ id: job.id, type: 'cancel' });
    }
  }

  private settle(job: Job, err: Error): void {
    if (job.settled) return;
    job.settled = true;
    job.reject(err);
  }

  private fulfill(job: Job, result: SimulationResult): void {
    if (job.settled) return;
    job.settled = true;
    job.resolve(result);
  }

  /** 按需扩容并把队列中的作业派发给空闲/新建的 worker */
  private schedule(): void {
    for (;;) {
      // 队首可能已在等待期间被取消
      while (this.queue.length > 0 && this.queue[0].settled) this.queue.shift();
      const job = this.queue.shift();
      if (!job) return;
      if (job.signal.aborted) {
        this.settle(job, new SimulationAbortedError());
        continue;
      }

      let worker = this.idle.pop() ?? null;
      if (!worker && this.liveCount() < this.concurrency) {
        worker = this.spawnWorker();
      }
      if (!worker) {
        // 并发上限已满且没有空闲 worker：放回队首等待
        this.queue.unshift(job);
        return;
      }

      job.worker = worker;
      this.running.set(worker, job);
      worker.postMessage({ id: job.id, type: 'start', input: job.input });
    }
  }

  private spawnWorker(): Worker {
    const slot = this.slots.findIndex((w) => w === null);
    if (slot === -1) throw new Error('没有可用的 worker 槽位');
    const worker = new Worker(this.bootstrap, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    // worker 只是主进程的计算从属：不应阻止进程退出（测试、CLI、SIGTERM
    // 关闭路径都依赖事件循环能自然收尾；shutdown() 会显式 terminate 它们）。
    worker.unref();
    this.slots[slot] = worker;

    worker.on('message', (response: WorkerResponse) => {
      const job = this.running.get(worker);
      if (!job || job.id !== response.id) return;
      this.running.delete(worker);

      if (response.ok) {
        // 客户端已走：丢弃结果（计算到此自然结束，不做多余动作）
        this.fulfill(job, response.result);
      } else if (response.errorKind === 'aborted' || job.signal.aborted) {
        this.settle(job, new SimulationAbortedError(response.error));
      } else if (response.errorKind === 'validation') {
        // 正常不会走到（路由层先校验），保留同样的 400 语义兜底
        this.settle(job, makeValidationError(response.error));
      } else {
        this.settle(job, new SimulationFailedError(response.error));
      }

      this.idle.push(worker);
      this.schedule();
    });

    // worker 内未捕获异常 / 线程退出：当前作业按内部错误处理，
    // 槽位置空，后续有需求时按需重建，维持既定并发度。
    const handleDeath = (message: string) => {
      const index = this.slots.indexOf(worker);
      if (index !== -1) this.slots[index] = null;
      const idleAt = this.idle.indexOf(worker);
      if (idleAt !== -1) this.idle.splice(idleAt, 1);
      const job = this.running.get(worker);
      if (job) {
        this.running.delete(worker);
        this.settle(
          job,
          job.signal.aborted
            ? new SimulationAbortedError()
            : new SimulationFailedError(message),
        );
      }
      if (!this.shuttingDown) this.schedule();
    };
    worker.on('error', (err) => handleDeath(err.message));
    worker.on('exit', (code) => {
      if (code !== 0) handleDeath(`仿真 worker 异常退出（code=${code}）`);
    });

    return worker;
  }

  /** 进程关闭时回收全部 worker；排队中与运行中的作业全部以结构化错误结束 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.queue.splice(0, this.queue.length).forEach((job) => {
      this.settle(job, new SimulationAbortedError('服务关闭'));
    });
    // 先把运行中的作业标记失败：terminate() 的退出码可能为 0，不能依赖
    // worker 的 exit 事件来 settle，否则作业会悬挂。
    this.running.forEach((job) => {
      this.settle(job, new SimulationAbortedError('服务关闭'));
    });
    this.running.clear();
    await Promise.all(
      this.slots.map(async (worker) => {
        if (!worker) return;
        try {
          worker.postMessage({ type: 'shutdown' });
          await worker.terminate();
        } catch {
          // 关闭路径上忽略终止错误
        }
      }),
    );
    this.slots.fill(null);
    this.idle.splice(0, this.idle.length);
    // 若关闭的是进程级单例（常见于测试收尾），清空引用，使下次取用重建
    if (pool === this) pool = null;
  }
}

/** 构造一个与路由层 ValidationError 同形状的错误，复用 400 处理路径 */
function makeValidationError(message: string): Error {
  const err = new Error(message);
  err.name = 'ValidationError';
  return err;
}

let pool: SimulationPool | null = null;

/** 进程级单例：所有仿真请求共享同一组 worker 与并发上限 */
export function getSimulationPool(): SimulationPool {
  if (!pool) pool = new SimulationPool();
  return pool;
}
