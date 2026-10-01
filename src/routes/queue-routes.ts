import { Router } from 'express';
import { analyzeQueue } from '../analytics/analytic.js';
import { SimulationAbortedError, SimulationWorkerPool } from '../simulation/worker-pool.js';
import {
  validateQueueParams,
  parseSimulationInput,
} from '../validation/validation.js';
import { buildComparison } from '../metrics/metrics.js';
import type { Request, Response, NextFunction } from 'express';
import type { SimulationInput, SimulationResult } from '../types.js';

/**
 * 三个业务接口。
 *
 * 解析（analytic）始终在主线程本地完成：它只是 O(K) 的几何级数，微秒级返回，
 * 永远不会被长仿真拖住——长仿真跑在工作线程上，主线程事件循环保持畅通。
 * 仿真（simulation / compare 中的仿真部分）交给工作线程池；调用方在结果
 * 返回前断开连接时，对应计算会被立即取消（排队中的不出队执行，运行中的
 * terminate 线程），不再空跑整段。
 */
export function createQueueRouter(pool: SimulationWorkerPool): Router {
  const router = Router();

  /** 仅算稳态解析 */
  router.post('/analytic', (req: Request, res: Response) => {
    const params = validateQueueParams(req.body ?? {});
    res.json(analyzeQueue(params));
  });

  /** 仅跑离散事件仿真 */
  router.post('/simulation', (req: Request, res: Response, next: NextFunction) => {
    runWithCancellation(parseSimulationInput(req.body ?? {}), pool, res, next, (result) => {
      res.json(result);
    });
  });

  /** 一次性输出解析 + 仿真及三样指标对照表 */
  router.post('/compare', (req: Request, res: Response, next: NextFunction) => {
    const input = parseSimulationInput(req.body ?? {});
    // 解析在主线程与线程池里的仿真并行进行（均为微秒级，先算后算都可）
    const analytic = analyzeQueue(input);
    runWithCancellation(input, pool, res, next, (simulation) => {
      res.json({
        input,
        analytic,
        simulation,
        comparison: buildComparison(analytic, simulation),
      });
    });
  });

  return router;
}

/**
 * 在线程池上跑一次仿真，并把“调用方提前断开”接成取消信号。
 * - 成功：sendResult(已算完的结果)；
 * - 客户端已断开：什么都不发，计算已在池里被取消；
 * - 线程池/worker 出错：交给统一错误处理器回结构化 5xx。
 */
function runWithCancellation(
  input: SimulationInput,
  pool: SimulationWorkerPool,
  res: Response,
  next: NextFunction,
  sendResult: (result: SimulationResult) => void,
): void {
  const { promise, cancel } = pool.run(input);

  const onAbort = () => {
    // 响应已经正常发出去之后 socket 关闭（keep-alive 回收等）不算取消
    if (!res.writableEnded) cancel();
  };
  // 'close' 在底层连接终止（含调用方主动断开）时触发
  res.on('close', onAbort);

  promise.then(
    (result) => {
      if (res.writableEnded || res.destroyed) return; // 断开期间完成：丢弃结果
      res.off('close', onAbort);
      sendResult(result);
    },
    (err: unknown) => {
      res.off('close', onAbort);
      if (err instanceof SimulationAbortedError) {
        // 连接还在（例如服务关闭）：回结构化的“已放弃”；连接已断则什么都不发
        if (!res.writableEnded && !res.destroyed) {
          res.status(503).json({ error: err.message, code: 'SIMULATION_ABORTED' });
        }
        return;
      }
      next(err);
    },
  );
}
