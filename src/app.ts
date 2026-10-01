import express, { type Request, type Response, type NextFunction } from 'express';
import { createQueueRouter } from './routes/queue-routes.js';
import { ValidationError } from './validation/validation.js';
import {
  SimulationExecutionError,
  SimulationWorkerPool,
} from './simulation/worker-pool.js';

/**
 * 装配 Express 应用。
 *
 * 仿真工作线程池在此创建并随应用生命周期回收：HTTP server 关闭（含
 * SIGTERM/SIGINT、自动化测试 server.close）时统一 destroy，避免线程泄漏。
 */
export function createApp(pool?: SimulationWorkerPool) {
  const simulationPool = pool ?? new SimulationWorkerPool();
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.use('/api', createQueueRouter(simulationPool));

  // 404
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `找不到路由：${req.method} ${req.path}` });
  });

  // 统一错误处理：输入非法统一 400，JSON 解析失败同样按非法请求处理
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: '请求体不是合法 JSON' });
      return;
    }
    if (err instanceof SimulationExecutionError) {
      // 已开始的计算中途失败：结构化 500，绝不回看似正常的结果
      res.status(500).json({ error: err.message, code: 'SIMULATION_FAILED' });
      return;
    }
    const message = err instanceof Error ? err.message : '内部错误';
    res.status(500).json({ error: message });
  });

  return app;
}
