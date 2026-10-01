import { Router } from 'express';
import { analyzeQueue } from '../analytics/analytic.js';
import { getSimulationPool } from '../simulation/sim-pool.js';
import { SimExecutionError } from '../simulation/errors.js';
import {
  validateQueueParams,
  parseSimulationInput,
  ValidationError,
} from '../validation/validation.js';
import { buildComparison } from '../metrics/metrics.js';
import type { Request, Response } from 'express';

const router = Router();

/**
 * 把异步 reject 的处理器包成 Express 兼容形式。
 * 校验错误（ValidationError）即使在 await 前同步抛出也会被这里兜住，
 * 按既有语义返回 400；执行期错误转结构化状态码响应。
 */
function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>,
) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((error: unknown) => {
      if (res.headersSent || res.writableEnded) return;
      if (error instanceof SimExecutionError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : '内部错误';
      res.status(500).json({ error: message });
    });
  };
}

/**
 * 调用方在响应发出前断开连接时，用 AbortController 通知线程池终止计算。
 * 注意不能监听 req 的 'close'：请求体流被读完（JSON 解析完）时它也会触发。
 * res 的 'close' 在连接提前断开、以及响应正常结束后都会触发，用
 * writableEnded 区分：只有“响应还没结束连接就断了”才取消计算。
 */
function bindAbort(req: Request, res: Response): AbortController {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded && !controller.signal.aborted) controller.abort();
  });
  // 极个别客户端在请求体阶段就断开
  req.on('aborted', () => {
    if (!controller.signal.aborted) controller.abort();
  });
  return controller;
}

/** 仅算稳态解析：纯计算、微秒级，留在主线程 */
router.post('/analytic', (req: Request, res: Response) => {
  const params = validateQueueParams(req.body ?? {});
  res.json(analyzeQueue(params));
});

/** 仅跑离散事件仿真：提交到 worker 池，避免长仿真占住事件循环 */
router.post(
  '/simulation',
  asyncHandler(async (req: Request, res: Response) => {
    // 入池前完成 400 校验：非法输入不占用任何仿真槽位
    const input = parseSimulationInput(req.body ?? {});
    const controller = bindAbort(req, res);
    const result = await getSimulationPool().run(input, controller.signal);
    // await 期间连接可能已断；不再尝试写响应
    if (res.writableEnded || req.aborted) return;
    res.json(result);
  }),
);

/** 一次性输出解析 + 仿真及三样指标对照表 */
router.post(
  '/compare',
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseSimulationInput(req.body ?? {});
    // 解析侧是轻量同步计算，先在主线程做完，不与 worker 池争抢
    const analytic = analyzeQueue(input);
    const controller = bindAbort(req, res);
    const simulation = await getSimulationPool().run(input, controller.signal);
    if (res.writableEnded || req.aborted) return;
    res.json({
      input,
      analytic,
      simulation,
      comparison: buildComparison(analytic, simulation),
    });
  }),
);

export default router;
