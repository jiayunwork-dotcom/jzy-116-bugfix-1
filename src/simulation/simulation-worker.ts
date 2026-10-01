import { parentPort } from 'node:worker_threads';
import { runSimulation } from './engine.js';
import type { SimulationInput } from '../types.js';

/**
 * 仿真工作线程入口。
 *
 * 仿真 CPU 密集且不可中断，放在主线程会在数秒内堵死事件循环（健康检查、
 * 解析请求、其它连接全部挨饿）。这里把每一次仿真放到独立的 worker_thread 上
 * 跑：worker 是独立的 V8 isolate + 事件循环，主线程因此始终能及时响应。
 *
 * 关键：worker 里调用的仍是 simulation/engine.ts 中那个逐位确定的
 * runSimulation（mulberry32 的每次抽取顺序、事件的处理顺序完全不变），
 * 只是换了执行单元。同 seed 的计算结果与改造前逐字段、逐位相同。
 *
 * 协议（主线程 -> worker）：
 *   { type: 'run', input: SimulationInput }
 * 协议（worker -> 主线程）：
 *   { type: 'result', result: SimulationResult }
 *   { type: 'error', message: string }
 *
 * 每个 worker 同一时刻只处理一个任务；取消由主线程直接 worker.terminate()
 * 完成（操作系统级中断，不依赖仿真循环内部的协作式检查点），因此即便仿真
 * 正处在一个长时间的紧密循环里，调用方断开后占用也会在毫秒级解除。
 */
parentPort?.on('message', (message: { type: string; input?: SimulationInput }) => {
  if (message.type !== 'run' || message.input === undefined) return;
  try {
    const result = runSimulation(message.input);
    parentPort?.postMessage({ type: 'result', result });
  } catch (err) {
    // 中途任何错误都结构化回传，绝不让 worker 异常静默消失
    parentPort?.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
