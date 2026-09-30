import type { SimulationInput, SimulationResult } from '../types.js';
import { Rng } from './rng.js';
import { EventList } from './event-list.js';
import { TimeWeightedAccumulator } from '../metrics/metrics.js';
import { parseSimulationInput } from '../validation/validation.js';

/**
 * M/M/1/K 的离散事件仿真。
 *
 * 与解析侧严格共用同一套语义：
 * - 状态 n = 系统内顾客数，0..K，含正在被服务的那一个；
 * - 到达间隔 Exp(λ)、服务时间 Exp(μ)；
 * - n === K 时到达请求直接丢弃并计入 rejected，绝不排队。
 *
 * 事件表驱动：只排 arrival / departure 两类事件。无论系统是否空闲、是否
 * 已满，到达流都按 λ 持续抽样——满员只会丢弃顾客，不会改变到达过程本身，
 * 因此 maxArrivals 是“到达尝试数（含被拒绝的）”，阻塞比例 = rejected /
 * 总到达尝试。停止条件 maxArrivals / maxTime 先到先停。
 */
export function runSimulation(rawInput: SimulationInput): SimulationResult {
  // 引擎自身也强制校验，非法入参不依赖路由层兜底
  const input = parseSimulationInput({ ...rawInput } as Record<string, unknown>);
  const { lambda, mu, capacity: k, seed, maxArrivals, maxTime } = input;

  const rng = new Rng(seed);
  const events = new EventList();
  const stats = new TimeWeightedAccumulator();

  let current = 0; // 当前系统内顾客数 n
  let clock = 0; // 仿真时钟
  let arrivals = 0; // 已抽样的到达尝试总数
  let accepted = 0;
  let rejected = 0;
  let stopReason: 'maxArrivals' | 'maxTime' | null = null;

  // 排第一个到达
  events.push('arrival', rng.exponential(lambda));

  for (;;) {
    const event = events.pop();
    // 没有事件理论上不会发生（到达流永续），兜底防止死循环
    if (!event) break;

    if (maxTime !== undefined && event.time >= maxTime) {
      stopReason = 'maxTime';
      clock = maxTime;
      break;
    }

    clock = event.time;

    if (event.kind === 'arrival') {
      arrivals += 1;

      if (current === k) {
        // 系统已满：直接拒绝，队长不变
        rejected += 1;
      } else {
        accepted += 1;
        const next = current + 1;
        stats.observe(clock, next);
        current = next;
        // 服务台此前空闲：本次到达立即开工，安排它的离开
        if (current === 1) {
          events.push('departure', clock + rng.exponential(mu));
        }
      }

      if (maxArrivals !== undefined && arrivals >= maxArrivals) {
        stopReason = 'maxArrivals';
        break;
      }
      // 到达过程不受阻塞影响：继续排下一个到达
      events.push('arrival', clock + rng.exponential(lambda));
    } else {
      // 一次服务完成，顾客离开
      const next = current - 1;
      stats.observe(clock, next);
      current = next;
      // 队列中仍有顾客：服务台不空转，立即开始下一次服务
      if (current > 0) {
        events.push('departure', clock + rng.exponential(mu));
      }
    }
  }

  const horizon = clock;
  // 统计时域截止后仍在系统中的顾客不再产生区间，结清时间加权面积
  const averages = stats.settle(horizon);

  const totalArrivals = arrivals;
  return {
    lambda,
    mu,
    capacity: k,
    seed,
    rngAlgorithm: rng.algorithm,
    stopReason: stopReason ?? 'maxTime',
    endTime: horizon,
    totalArrivals,
    accepted,
    rejected,
    // 无到达样本时经验阻塞比例定义为 0
    blockingProbability:
      totalArrivals > 0 ? rejected / totalArrivals : 0,
    ...averages,
    effectiveArrivalRate: horizon > 0 ? accepted / horizon : 0,
  };
}
