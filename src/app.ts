import express, { type Request, type Response, type NextFunction } from 'express';
import queueRoutes from './routes/queue-routes.js';
import { ValidationError } from './validation/validation.js';

export function createApp() {
  const app = express();

  // 连接安全：调用方在响应完成前主动断开（典型场景：长仿真等不及而 abort）
  // 时，立刻在服务端销毁底层 socket，尽快把 FIN 发出去。
  //
  // 这属于正确的连接卫生：请求已被调用方放弃，该 keep-alive 连接不应再承载
  // 任何后续请求，被放弃的计算也不会借它返回半截结果。正常完成的请求
  // writableFinished 为 true，默认 keep-alive 行为完全不变。
  //
  // 注意：客户端若在 abort 之后长时间阻塞自己的事件循环（例如在同一个
  // Node 进程里同步跑数秒 CPU），它会来不及处理本端发出的 FIN，仍可能
  // 错误地复用一条已死连接——那是客户端未消费 TCP 状态导致的，服务端
  // 无法在协议层面替它纠正；不阻塞事件循环的调用方不受影响。
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on('close', () => {
      if (!res.writableFinished) {
        req.socket.destroy();
      }
    });
    next();
  });

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
