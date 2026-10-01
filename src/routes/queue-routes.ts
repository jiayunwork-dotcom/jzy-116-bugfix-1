import { Router } from 'express';
import { analyzeQueue } from '../analytics/analytic.js';
import {
  getSimulationPool,
  SimulationAbortedError,
  SimulationFailedError,
} from '../simulation/pool.js';
import {
  validateQueueParams,
  parseSimulationInput,
} from '../validation/validation.js';
import { buildComparison } from '../metrics/metrics.js';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

const router = Router();

/**
 * Express 4 不会自动捕获 async 处理器 reject 的错误（同步抛出在 async 函数里
 * 也会变成 rejected promise）。用该包装把所有异常交给 next(err)，使输入校验
 * 等错误仍能走到 app 的统一错误处理中间件，维持既有 400 语义。
 */
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** 仅算稳态解析（纯计算、亚毫秒级，始终在主线程同步完成） */
router.post('/analytic', (req: Request, res: Response) => {
  const params = validateQueueParams(req.body ?? {});
  res.json(analyzeQueue(params));
});

/**
 * 仿真在独立 worker 中并行执行：
 * - 主线程不被长仿真占住，健康检查与解析请求始终即时应答；
 * - 客户端在结果返回前断开时，res 的 'close'（未 finish）触发 abort，
 *   worker 侧在当前分片边界停下（见 sim-worker.ts），不空跑完整时长；
 * - 输入非法由 asyncHandler 交给统一错误中间件回 400；
 * - 被取消/失败的作业绝不当作正常结果返回。
 */
router.post(
  '/simulation',
  asyncHandler(async (req: Request, res: Response) => {
    // 先同步校验：非法输入维持 400 + 字段说明的既有语义，不进 worker
    const input = parseSimulationInput(req.body ?? {});

    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);

    try {
      const result = await getSimulationPool().run(input, controller.signal);
      // await 期间连接可能已断开：不再尝试写（连接安全中间件已销毁 socket）
      if (res.writableEnded || res.destroyed || req.aborted) return;
      res.json(result);
    } catch (err) {
      respondSimulationError(err, req, res);
    } finally {
      res.off('close', onClose);
    }
  }),
);

/** 一次性输出解析 + 仿真及三样指标对照表 */
router.post(
  '/compare',
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseSimulationInput(req.body ?? {});
    const analytic = analyzeQueue(input);

    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);

    let simulation;
    try {
      simulation = await getSimulationPool().run(input, controller.signal);
    } catch (err) {
      respondSimulationError(err, req, res);
      return;
    } finally {
      res.off('close', onClose);
    }
    if (res.writableEnded || res.destroyed || req.aborted) return;
    res.json({
      input,
      analytic,
      simulation,
      comparison: buildComparison(analytic, simulation),
    });
  }),
);

/**
 * 仿真特有的运行期错误响应（输入校验错误不在此处理，已交给统一 400）：
 * - 调用方已断开：不回“正常结果”，若连接仍存活则给明确的 499 结构化错误；
 * - 计算中途异常 / worker 崩溃：500 结构化错误，不让进程挂掉或静默吞掉。
 */
function respondSimulationError(
  err: unknown,
  req: Request,
  res: Response,
): void {
  // 客户端已经断开（底层连接也已被 app 的连接安全中间件销毁）：
  // 没有对象可接收响应，绝不能向已销毁的流写入，只需保证不返回正常结果。
  if (res.writableEnded || res.destroyed || req.aborted) {
    if (!(err instanceof SimulationAbortedError) && !req.aborted) {
      // 连接已断却并非取消导致的失败，至少在服务端留痕，不静默吞掉
      console.error('仿真作业失败且响应无法写出：', err);
    }
    return;
  }
  const message = err instanceof Error ? err.message : '仿真计算失败';

  if (err instanceof SimulationAbortedError) {
    // 连接仍然存活却收到了取消（例如关闭中）：结构化错误，不伪装成正常结果
    res.status(499).json({ error: message });
    return;
  }
  if (err instanceof SimulationFailedError) {
    res.status(500).json({ error: `仿真计算失败：${message}` });
    return;
  }
  // 兜底：worker 内校验失败（正常在进池前已被拦截）仍按 400 返回
  if (err instanceof Error && err.name === 'ValidationError') {
    res.status(400).json({ error: message });
    return;
  }
  // 计算中途抛出的任何其它异常：结构化 500，进程不挂、错误不静默
  console.error('仿真作业未预期错误：', err);
  res.status(500).json({ error: message });
}

export default router;
