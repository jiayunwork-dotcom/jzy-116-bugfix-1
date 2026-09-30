import { Router } from 'express';
import { analyzeQueue } from '../analytics/analytic.js';
import { runSimulation } from '../simulation/engine.js';
import {
  validateQueueParams,
  parseSimulationInput,
} from '../validation/validation.js';
import { buildComparison } from '../metrics/metrics.js';
import type { Request, Response } from 'express';

const router = Router();

/** 仅算稳态解析 */
router.post('/analytic', (req: Request, res: Response) => {
  const params = validateQueueParams(req.body ?? {});
  res.json(analyzeQueue(params));
});

/** 仅跑离散事件仿真 */
router.post('/simulation', (req: Request, res: Response) => {
  const input = parseSimulationInput(req.body ?? {});
  res.json(runSimulation(input));
});

/** 一次性输出解析 + 仿真及三样指标对照表 */
router.post('/compare', (req: Request, res: Response) => {
  const input = parseSimulationInput(req.body ?? {});
  const analytic = analyzeQueue(input);
  const simulation = runSimulation(input);
  res.json({
    input,
    analytic,
    simulation,
    comparison: buildComparison(analytic, simulation),
  });
});

export default router;
