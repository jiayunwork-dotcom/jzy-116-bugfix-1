// 仿真工作线程入口（普通 JS：不依赖 TypeScript 编译即可在 worker_threads
// 里直接运行；tsc 以 allowJs 原样拷贝到 dist，开发期与生产期路径完全一致）。
//
// 协议：父线程 postMessage({ id, input }) ->
//       本线程回 { type: 'result', id, result } 或 { type: 'error', id, message }。
// 同一时刻只处理一个作业，因此结果天然有序；每个作业的 RNG/事件表/累加器
// 都是引擎内部 new 出来的局部对象，两个并发作业之间不存在任何共享可变状态。
import { parentPort, workerData } from 'node:worker_threads';

// 开发/测试（tsx）下引擎是 .ts 源码，worker 线程不继承主线程的 tsx 加载器，
// 需要在线程内自行注册一次；生产（dist）下引擎是已编译的 .js，无需注册，
// 而且镜像里 tsx 已被 prune——registerTsx 为 false 时这里不会去 import 它。
if (workerData && workerData.registerTsx) {
  const { register } = await import('tsx/esm/api');
  register();
}

const engine = await import(workerData.enginePath);
const runSimulation = engine.runSimulation;

parentPort.on('message', (message) => {
  const { id, input } = message;
  try {
    const result = runSimulation(input);
    parentPort.postMessage({ type: 'result', id, result });
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

parentPort.postMessage({ type: 'ready' });
