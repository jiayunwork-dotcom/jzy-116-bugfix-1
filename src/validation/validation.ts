import type { QueueParams, SimulationInput } from '../types.js';

/** 输入非法时抛出，路由层据此返回 400 */
export class ValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** 防止无节制请求把稳态向量/仿真拖垮 */
const MAX_CAPACITY = 100_000;
const MAX_RATE = 1e9;
const MAX_SEED = 0xffffffff; // 2^32 - 1
const MAX_STOP = 1e9;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 校验排队三要素：
 * - 到达率、服务率必须为正数；
 * - 容量必须为正整数（含正在服务的那一个）。
 *
 * 路由层与解析/仿真引擎共用这一处规则，保证直接调用也无法绕过校验。
 */
export function validateQueueParams(body: Record<string, unknown>): QueueParams {
  const { lambda, mu, capacity } = body;

  if (!isFiniteNumber(lambda) || lambda <= 0) {
    throw new ValidationError('lambda（到达率）必须为正数');
  }
  if (lambda > MAX_RATE) {
    throw new ValidationError(`lambda（到达率）不能超过 ${MAX_RATE}`);
  }
  if (!isFiniteNumber(mu) || mu <= 0) {
    throw new ValidationError('mu（服务率）必须为正数');
  }
  if (mu > MAX_RATE) {
    throw new ValidationError(`mu（服务率）不能超过 ${MAX_RATE}`);
  }
  if (
    !isFiniteNumber(capacity) ||
    !Number.isInteger(capacity) ||
    capacity <= 0
  ) {
    throw new ValidationError('capacity（系统总容量）必须为正整数');
  }
  if (capacity > MAX_CAPACITY) {
    throw new ValidationError(`capacity 不能超过 ${MAX_CAPACITY}`);
  }

  return { lambda, mu, capacity };
}

/**
 * 校验仿真入参。种子必须能落到 uint32；停止条件 maxArrivals / maxTime
 * 至少给出一个，二者为“先到先停”。
 */
export function parseSimulationInput(body: Record<string, unknown>): SimulationInput {
  const params = validateQueueParams(body);
  const { seed, maxArrivals, maxTime } = body;

  const seedDefault = 1;
  let resolvedSeed: number;
  if (seed === undefined) {
    resolvedSeed = seedDefault;
  } else if (
    !isFiniteNumber(seed) ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > MAX_SEED
  ) {
    throw new ValidationError(`seed 必须是 [0, ${MAX_SEED}] 内的整数`);
  } else {
    resolvedSeed = seed;
  }

  let resolvedMaxArrivals: number | undefined;
  if (maxArrivals !== undefined) {
    if (
      !isFiniteNumber(maxArrivals) ||
      !Number.isInteger(maxArrivals) ||
      maxArrivals <= 0 ||
      maxArrivals > MAX_STOP
    ) {
      throw new ValidationError(`maxArrivals 必须是 [1, ${MAX_STOP}] 内的整数`);
    }
    resolvedMaxArrivals = maxArrivals;
  }

  let resolvedMaxTime: number | undefined;
  if (maxTime !== undefined) {
    if (!isFiniteNumber(maxTime) || maxTime <= 0 || maxTime > MAX_STOP) {
      throw new ValidationError(`maxTime 必须是 (0, ${MAX_STOP}] 内的数`);
    }
    resolvedMaxTime = maxTime;
  }

  if (resolvedMaxArrivals === undefined && resolvedMaxTime === undefined) {
    throw new ValidationError('必须至少提供一种停止条件：maxArrivals 或 maxTime');
  }

  return {
    ...params,
    seed: resolvedSeed,
    maxArrivals: resolvedMaxArrivals,
    maxTime: resolvedMaxTime,
  };
}
