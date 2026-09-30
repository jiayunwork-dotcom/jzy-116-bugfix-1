import express, { type Request, type Response, type NextFunction } from 'express';
import queueRoutes from './routes/queue-routes.js';
import { ValidationError } from './validation/validation.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.use('/api', queueRoutes);

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
    const message = err instanceof Error ? err.message : '内部错误';
    res.status(500).json({ error: message });
  });

  return app;
}
