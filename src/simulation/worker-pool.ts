import { Worker } from 'node:worker_threads';
import os from 'node:os';
import type { SimulationInput, SimulationResult } from '../types.js';

/**
 * 调用方在结果返回前主动断开连接 / 服务关闭：本次仿真被放弃。
 * 路由层据此区分“什么都不回（连接已断）”与“正常但繁忙”的情形。
 */
export class SimulationAbortedError extends Error {
  constructor(message = '仿真任务已被放弃（客户端断开连接或服务正在关闭）') {
    super(message);
    this.name = 'SimulationAbortedError';
  }
}

/**
 * 工作线程自身出错 / 异常退出：已开始的计算没能正常结束。
 * 必须回结构化的 5xx 错误，绝不能伪装成正常结果或静默吞掉。
 */
export class SimulationExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationExecutionError';
  }
}

interface RunRequest {
  input: SimulationInput;
  resolve: (result: SimulationResult) => void;
  reject: (err: Error) => void;
}

interface Slot {
  /** 当前驻留的 worker；id === 0 表示空闲，可派发新任务 */
  worker: Worker | null;
  /** 该 worker 正在处理的请求（从派发到 exit 之间一直挂在 slot 上） */
  current: RunRequest | null;
  /** worker 代数标识：每次派发递增，用来忽略上一代 worker 的迟到事件 */
  id: number;
  /** 该请求是否已结算（resolve/reject），防止 exit 重复结算 */
  settled: boolean;
}

/**
 * 固定大小的仿真工作线程池。
 *
 * 设计取舍（见根目录 并发改造说明.md）：
 * - 选 worker_threads 并行，而非在主线程里分段让出：只有独立线程才能让健康
 *   检查/解析请求在长仿真跑满 CPU 时仍稳定地在毫秒级返回，也才能让多个长
 *   仿真真正并行（分段方案仍共享一个事件循环，并行度为 1）。
 * - 容量固定（默认 = 物理并行度，封顶 8，可用 SIMULATION_WORKERS 覆盖）。
 *   超出容量的请求排队等待而不是直接拒绝：仿真请求彼此公平、先到先得；
 *   短请求（健康检查/解析）走主线程，永远不会排在长仿真后面挨饿。
 * - 每个任务用一个全新的 worker isolate 执行，结束/取消即 terminate：天然
 *   保证多次仿真的随机数状态、堆内存严格隔离，不会因交错执行串到一起。
 * - 取消正在运行的任务直接 terminate 对应 worker（毫秒级、不依赖协作式
 *   检查点），排队中的任务取消则直接出队，都不再占用算力。
 *
 * 生命周期与竞态防护：一个 slot 从派发到该 worker 的 'exit' 真正触发前都算
 * 忙（即使结果已先一步返回）。每个 worker 带递增的代数 id，迟到的上一代
 * 'exit' / 'message' 因 id 不匹配被整体忽略，绝不会清空新一代 worker 的状态。
 */
export class SimulationWorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: RunRequest[] = [];
  private destroyed = false;
  private generation = 0;

  constructor(size = SimulationWorkerPool.defaultSize()) {
    for (let i = 0; i < size; i += 1) {
      this.slots.push({ worker: null, current: null, id: 0, settled: true });
    }
  }

  static defaultSize(): number {
    const fromEnv = Number(process.env.SIMULATION_WORKERS);
    if (Number.isInteger(fromEnv) && fromEnv >= 1) return fromEnv;
    return Math.min(Math.max(os.availableParallelism(), 1), 8);
  }

  /** 当前可并行执行仿真的线程数 */
  get size(): number {
    return this.slots.length;
  }

  /**
   * 提交一次仿真。返回结果 Promise 与取消句柄；调用方断开时由路由层 cancel()。
   */
  run(input: SimulationInput): {
    promise: Promise<SimulationResult>;
    cancel: () => void;
  } {
    if (this.destroyed) {
      return {
        promise: Promise.reject(new SimulationAbortedError('服务正在关闭')),
        cancel: () => {},
      };
    }

    const pending: RunRequest = {
      input,
      resolve: () => {},
      reject: () => {},
    };
    const promise = new Promise<SimulationResult>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });

    this.queue.push(pending);
    this.pump();

    return {
      promise,
      cancel: () => this.cancel(pending),
    };
  }

  /** 把排队任务派发给空闲 slot（id === 0） */
  private pump(): void {
    if (this.destroyed) return;
    for (const slot of this.slots) {
      if (this.queue.length === 0) break;
      if (slot.id !== 0) continue; // 该 slot 的 worker 尚未 exit，仍算忙
      const request = this.queue.shift() as RunRequest;
      this.start(slot, request);
    }
  }

  private start(slot: Slot, request: RunRequest): void {
    const id = ++this.generation;
    slot.id = id;
    slot.settled = false;
    slot.current = request;

    let worker: Worker;
    try {
      worker = new Worker(new URL('./worker-bootstrap.mjs', import.meta.url));
    } catch (err) {
      // worker 都没建起来：直接释放 slot 并结算
      slot.id = 0;
      slot.current = null;
      slot.settled = true;
      request.reject(
        new SimulationExecutionError(
          `无法启动仿真工作线程：${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      this.pump();
      return;
    }
    slot.worker = worker;

    worker.on('message', (message: {
      type: string;
      result?: SimulationResult;
      message?: string;
    }) => {
      // 代数不匹配（迟到的旧 worker 消息）或已结算：忽略
      if (slot.id !== id || slot.current !== request || slot.settled) return;
      if (message.type === 'result' && message.result !== undefined) {
        const result = message.result;
        this.settle(slot, () => request.resolve(result));
      } else if (message.type === 'error') {
        this.settle(slot, () =>
          request.reject(
            new SimulationExecutionError(message.message ?? '仿真工作线程报错'),
          ),
        );
      }
    });

    // worker 内未捕获异常（正常错误已在 worker 内 try/catch，这里是兜底）
    worker.on('error', (err) => {
      if (slot.id !== id || slot.settled) return;
      this.settle(slot, () =>
        request.reject(
          new SimulationExecutionError(
            `仿真工作线程异常：${err instanceof Error ? err.message : String(err)}`,
          ),
        ),
      );
    });

    // 正常结束 / 被 terminate / 崩溃都会触发 exit；只有它能把 slot 真正释放
    worker.on('exit', (code) => {
      if (slot.id !== id) return; // 上一代 worker 的迟到 exit：什么都别碰
      const wasUnsettled = !slot.settled;
      slot.worker = null;
      slot.current = null;
      slot.id = 0;
      slot.settled = true;
      if (wasUnsettled && !this.destroyed) {
        // 没有 result/error 消息、也不是被主动 terminate：异常退出
        request.reject(
          new SimulationExecutionError(`仿真工作线程意外退出（exit code ${code}）`),
        );
      }
      this.pump();
    });

    worker.postMessage({ type: 'run', input: request.input });
  }

  /**
   * 收到结果/错误：结算 Promise 并 terminate worker。slot 仍保持忙，直到
   * 对应的 'exit' 触发才释放，避免在旧 worker 退出前把同一 slot 派给新任务。
   */
  private settle(slot: Slot, apply: () => void): void {
    if (slot.settled) return;
    slot.settled = true;
    apply();
    // terminate 已结束的 worker 无害；exit 事件随后触发并释放 slot
    slot.worker?.terminate().catch(() => {});
  }

  /**
   * 放弃一个任务：
   * - 还在排队：直接出队 reject，完全不占算力；
   * - 正在运行：terminate 它的 worker，计算在毫秒级真正停下；slot 等 exit 释放。
   */
  private cancel(request: RunRequest): void {
    const queuedIndex = this.queue.indexOf(request);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      request.reject(new SimulationAbortedError());
      return;
    }
    const slot = this.slots.find((s) => s.current === request);
    if (slot && !slot.settled) {
      slot.settled = true; // 告诉随后的 exit：取消是预期内的，别再按崩溃结算
      request.reject(new SimulationAbortedError());
      slot.worker?.terminate().catch(() => {}); // exit 触发时才真正释放 slot
    }
  }

  /** 服务关闭：拒绝/中断全部任务并回收线程 */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const request of this.queue.splice(0)) {
      request.reject(new SimulationAbortedError('服务正在关闭'));
    }
    const workers = this.slots
      .map((slot) => {
        if (slot.current !== null && !slot.settled) {
          slot.settled = true;
          slot.current.reject(new SimulationAbortedError('服务正在关闭'));
        }
        const worker = slot.worker;
        return worker;
      })
      .filter((w): w is Worker => w !== null);

    await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  }
}
