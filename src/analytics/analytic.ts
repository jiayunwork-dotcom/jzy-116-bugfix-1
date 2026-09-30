import type { AnalyticResult, QueueParams } from '../types.js';
import { validateQueueParams } from '../validation/validation.js';

/**
 * M/M/1/K 稳态分布。
 *
 * 生灭过程（到达率 λ、服务率 μ、状态 n = 0..K）的细致平衡条件给出
 *   π_n = π_0 * (λ/μ)^n = π_0 * ρ^n，
 * 即各状态概率按比值 ρ 构成几何级数，再由 Σπ_n = 1 归一化。
 * 比值恰好为 1 时级数退化为均匀分布 π_n = 1/(K+1)。
 *
 * 这里用对数空间 + 平移的方式算几何权重，避免 ρ > 1、K 较大时 ρ^K
 * 直接上溢成 Infinity 而得到 NaN。
 *
 * @returns stateProbabilities[n] = π_n，n 为系统内顾客数（含服务中的）
 */
export function steadyStateDistribution(
  rho: number,
  capacity: number,
): number[] {
  const k = capacity;
  const probabilities = new Array<number>(k + 1);

  if (rho === 1) {
    // 退化情形：均匀分布
    probabilities.fill(1 / (k + 1));
    return probabilities;
  }

  const logRho = Math.log(rho);
  // 平移指数项不影响归一化结果，但能保证中间量不溢出
  const maxLog = rho > 1 ? k * logRho : 0;

  let partition = 0;
  for (let n = 0; n <= k; n++) {
    const weight = Math.exp(n * logRho - maxLog);
    probabilities[n] = weight;
    partition += weight;
  }
  for (let n = 0; n <= k; n++) {
    probabilities[n] /= partition;
  }
  return probabilities;
}

/**
 * 由稳态分布推导各项运行指标。单独导出，便于测试极端情形
 * （有效到达率为 0 时逗留时间必须有定义，不能除出无穷）。
 */
export function deriveMetrics(
  params: QueueParams,
  probabilities: number[],
): Omit<AnalyticResult, keyof QueueParams | 'rho' | 'stateProbabilities'> {
  const { lambda, mu, capacity: k } = params;

  const pi0 = probabilities[0];
  const piK = probabilities[k];

  const blockingProbability = piK;
  // 有效到达率：名义到达率中未被阻塞的那部分
  const effectiveArrivalRate = lambda * (1 - piK);
  // 利用率 = λ_e / μ；恒等于 1 - π_0（PASTA 下到达所见与时间平均一致）
  const utilization = effectiveArrivalRate / mu;

  let meanNumberInSystem = 0;
  let meanNumberWaiting = 0;
  for (let n = 0; n <= k; n++) {
    const p = probabilities[n];
    meanNumberInSystem += n * p;
    meanNumberWaiting += Math.max(n - 1, 0) * p;
  }

  // 有效到达率为 0 的极端情形：没有顾客能进入系统，逗留/等待时间定义为 0
  const meanTimeInSystem =
    effectiveArrivalRate > 0 ? meanNumberInSystem / effectiveArrivalRate : 0;
  const meanWaitingTime =
    effectiveArrivalRate > 0 ? meanNumberWaiting / effectiveArrivalRate : 0;

  return {
    blockingProbability,
    effectiveArrivalRate,
    utilization,
    meanNumberInSystem,
    meanNumberWaiting,
    meanTimeInSystem,
    meanWaitingTime,
  };
}

/** 一次性算出 M/M/1/K 的全部稳态结果 */
export function analyzeQueue(params: QueueParams): AnalyticResult {
  const valid = validateQueueParams({ ...params } as Record<string, unknown>);
  const { lambda, mu, capacity } = valid;
  const rho = lambda / mu;
  const stateProbabilities = steadyStateDistribution(rho, capacity);
  const metrics = deriveMetrics(params, stateProbabilities);
  return {
    ...params,
    rho,
    stateProbabilities,
    ...metrics,
  };
}
