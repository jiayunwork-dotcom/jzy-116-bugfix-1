import { parentPort } from 'node:worker_threads';
import { createSimulation, SimulationRunner } from './engine.js';
import type { SimulationResult } from '../types.js';
import {
  isValidationError,
  serializeError,
  type WorkerRequest,
  type WorkerResponse,
} from './worker-protocol.js';

/**
 * 仿真 worker 入口：在独立线程内推进离散事件仿真。
 *
 * 关键点：
 * - RNG、事件表、统计累加器全部是 {@link SimulationRunner} 的实例局部状态，
 *   不接触任何共享可变状态，因此多个 worker 并行、或同一 worker 先后跑多个
 *   作业时，随机数序列与统计量彼此独立、绝不串线；
 * - 每处理 {@link CHUNK_EVENTS} 个事件就让出一次（setImmediate），让出点
 *   只影响调度时机：仿真在“两个事件之间”暂停，恢复后接着弹下一个事件，
 *   没有任何事件被重放或跳过，RNG 的调用次序也完全不变，所以同一 seed
 *   无论连续跑完还是分段/交错跑完，结果逐位相同；
 * - 每个分片边界检查一次取消标志：调用方断开连接后，最多再跑一个分片
 *   （约几十毫秒）就停下，不再继续占用 CPU，也绝不回传看起来正常的结果。
 */
const CHUNK_EVENTS = 100_000;

if (!parentPort) {
  throw new Error('sim-worker 必须作为 worker 线程加载');
}
const port = parentPort;

let currentId: number | null = null;
let runner: SimulationRunner | null = null;
let cancelled = false;

function post(response: WorkerResponse): void {
  port.postMessage(response);
}

/** 发送结果并清空当前作业现场，使 worker 可接下一单 */
function finishJob(response: WorkerResponse): void {
  currentId = null;
  runner = null;
  cancelled = false;
  post(response);
}

/** 消费一个分片后返回是否应继续；返回 false 表示作业已结束或应停止调度 */
function runChunk(): boolean {
  if (currentId === null || runner === null) return false;
  const id = currentId;

  for (let n = 0; n < CHUNK_EVENTS; n++) {
    let keepGoing: boolean;
    try {
      keepGoing = runner.step();
    } catch (err) {
      finishJob(serializeError(id, err, isValidationError(err)));
      return false;
    }
    if (!keepGoing) {
      let result: SimulationResult;
      try {
        result = runner.finish();
      } catch (err) {
        finishJob(serializeError(id, err, isValidationError(err)));
        return false;
      }
      finishJob({ id, ok: true, result });
      return false;
    }
  }

  if (cancelled) {
    finishJob({
      id,
      ok: false,
      errorKind: 'aborted',
      error: '仿真已被调用方取消（连接已断开）',
    });
    return false;
  }
  return true;
}

/** 分片驱动：每片之间用 setImmediate 让出，给取消消息留出处理时机 */
function pump(): void {
  if (!runChunk()) return;
  setImmediate(pump);
}

port.on('message', (message: WorkerRequest) => {
  if (message.type === 'shutdown') {
    port.close();
    return;
  }

  if (message.type === 'cancel') {
    // 只取消当前作业；取消一个不存在/已结束的作业是无害空操作
    if (message.id === currentId) cancelled = true;
    return;
  }

  // start：正常情况下 worker 一次只跑一单；若仍有上一单在跑则拒绝新单，
  // 由线程池排程保证不会发生，这里仅做防御。
  if (currentId !== null) {
    post({
      id: message.id,
      ok: false,
      errorKind: 'internal',
      error: 'worker 正忙',
    });
    return;
  }

  currentId = message.id;
  cancelled = false;
  try {
    runner = createSimulation(message.input);
  } catch (err) {
    finishJob(serializeError(message.id, err, isValidationError(err)));
    return;
  }
  pump();
});
