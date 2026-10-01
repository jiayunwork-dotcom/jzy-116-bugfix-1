import { createApp } from './app.js';
import { getSimulationPool } from './simulation/sim-pool.js';

const port = Number(process.env.PORT ?? 8080);

const app = createApp();
const server = app.listen(port, () => {
  console.log(`M/M/1/K 排队核算服务已启动，监听端口 ${port}`);
});

// keep-alive 空闲连接的生命周期：headersTimeout 必须严格大于 keepAliveTimeout，
// 否则服务端先进入关闭窗口、客户端却仍可能把请求复用到这条“将关未关”的
// 连接上（Node 服务端 + 连接池客户端的经典竞态，表现为偶发 ECONNRESET）。
server.keepAliveTimeout = 5_000;
server.headersTimeout = 6_000;
// 长仿真是合法的长请求，不能被默认请求超时砍掉
server.requestTimeout = 0;

let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;

    // 立即停止接受新连接，并断开所有现存 socket（含在途长仿真对应的连接，
    // 路由层会感知 res close 而中止作业；这里不等待它们跑完）。worker 线程
    // 随进程退出被内核一并回收，因此直接 exit，停机耗时只取决于 close 回调。
    server.close(() => process.exit(0));
    server.closeAllConnections?.();

    // 终止全部仿真 worker（显式释放，不依赖进程退出），忽略其结果
    getSimulationPool()
      .shutdown()
      .catch(() => {});

    // 兜底：正常情况下 server.close 回调会立刻触发；极端残留时 1s 强退
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
