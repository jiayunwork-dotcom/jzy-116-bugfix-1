import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8080);

const server = createApp().listen(port, () => {
  console.log(`M/M/1/K 排队核算服务已启动，监听端口 ${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
