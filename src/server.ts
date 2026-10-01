import { createApp } from './app.js';
import { SimulationWorkerPool } from './simulation/worker-pool.js';

const port = Number(process.env.PORT ?? 8080);

const pool = new SimulationWorkerPool();
const server = createApp(pool).listen(port, () => {
  console.log(
    `M/M/1/K 排队核算服务已启动，监听端口 ${port}（仿真工作线程数 ${pool.size}）`,
  );
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // 先终止还在跑的仿真，再停止接收新连接，避免长计算把退出拖很久
  await pool.destroy();
  server.close(() => process.exit(0));
  // 兜底：即使还有长连接挂着，也强制退出
  setTimeout(() => process.exit(0), 2000).unref();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, shutdown);
}
