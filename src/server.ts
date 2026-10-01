import { createApp } from './app.js';
import { getSimulationPool } from './simulation/pool.js';

const port = Number(process.env.PORT ?? 8080);

const server = createApp().listen(port, () => {
  console.log(`M/M/1/K 排队核算服务已启动，监听端口 ${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    // 先停接入，再回收仿真 worker，避免线程悬挂拖住退出
    server.close(() => {
      void getSimulationPool()
        .shutdown()
        .then(() => process.exit(0))
        .catch(() => process.exit(0));
    });
  });
}
