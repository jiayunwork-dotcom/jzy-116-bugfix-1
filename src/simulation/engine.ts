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
 *
 * 除一次性跑完的 {@link runSimulation} 之外，这里还把同一份主循环拆成
 * “可分段推进”的 {@link SimulationRunner}：每次 {@link SimulationRunner.step}
 * 恰好弹出并处理一个事件，调用方可以在任意两个事件之间让出执行权。
 * 分段推进只改变调度时机、不改变任何运算顺序——RNG 仍由该仿真实例独占，
 * 事件表、统计累加器也都是实例内局部状态，所以无论连续跑完还是与其它
 * 仿真交错分段跑完，同一 seed 的结果逐位一致。
 */

/** 停止条件触发原因；null 表示尚未停止 */
export type SimulationStopReason = 'maxArrivals' | 'maxTime' | null;

/**
 * 可分段推进的仿真运行器：构造后通过反复调用 {@link step} 推进事件，
 * 返回 false 表示已触发停止条件，随后调用 {@link finish} 取最终结果。
 */
export class SimulationRunner {
  readonly input: SimulationInput;
  private readonly rng: Rng;
  private readonly events = new EventList();
  private readonly stats = new TimeWeightedAccumulator();

  private current = 0; // 当前系统内顾客数 n
  private clock = 0; // 仿真时钟
  private arrivals = 0; // 已抽样的到达尝试总数
  private accepted = 0;
  private rejected = 0;
  private stopReason: SimulationStopReason = null;

  constructor(rawInput: SimulationInput) {
    // 引擎自身也强制校验，非法入参不依赖路由层兜底
    this.input = parseSimulationInput({
      ...rawInput,
    } as Record<string, unknown>);
    this.rng = new Rng(this.input.seed);
    // 排第一个到达
    this.events.push('arrival', this.rng.exponential(this.input.lambda));
  }

  /**
   * 弹出并处理下一个事件。返回 false 表示仿真已停止（不应再调用）。
   * 每个事件内部的运算次序与原单循环实现严格一致。
   */
  step(): boolean {
    const { maxTime, maxArrivals, lambda, mu, capacity: k } = this.input;
    const event = this.events.pop();
    // 没有事件理论上不会发生（到达流永续），兜底防止死循环
    if (!event) return false;

    if (maxTime !== undefined && event.time >= maxTime) {
      this.stopReason = 'maxTime';
      this.clock = maxTime;
      return false;
    }

    this.clock = event.time;

    if (event.kind === 'arrival') {
      this.arrivals += 1;

      if (this.current === k) {
        // 系统已满：直接拒绝，队长不变
        this.rejected += 1;
      } else {
        this.accepted += 1;
        const next = this.current + 1;
        this.stats.observe(this.clock, next);
        this.current = next;
        // 服务台此前空闲：本次到达立即开工，安排它的离开
        if (this.current === 1) {
          this.events.push('departure', this.clock + this.rng.exponential(mu));
        }
      }

      if (maxArrivals !== undefined && this.arrivals >= maxArrivals) {
        this.stopReason = 'maxArrivals';
        return false;
      }
      // 到达过程不受阻塞影响：继续排下一个到达
      this.events.push('arrival', this.clock + this.rng.exponential(lambda));
    } else {
      // 一次服务完成，顾客离开
      const next = this.current - 1;
      this.stats.observe(this.clock, next);
      this.current = next;
      // 队列中仍有顾客：服务台不空转，立即开始下一次服务
      if (this.current > 0) {
        this.events.push('departure', this.clock + this.rng.exponential(mu));
      }
    }
    return true;
  }

  /** 结清时间加权面积并组装最终结果，逻辑与一次性实现完全相同 */
  finish(): SimulationResult {
    const { lambda, mu, capacity: k, seed } = this.input;
    const horizon = this.clock;
    // 统计时域截止后仍在系统中的顾客不再产生区间，结清时间加权面积
    const averages = this.stats.settle(horizon);

    const totalArrivals = this.arrivals;
    return {
      lambda,
      mu,
      capacity: k,
      seed,
      rngAlgorithm: this.rng.algorithm,
      stopReason: this.stopReason ?? 'maxTime',
      endTime: horizon,
      totalArrivals,
      accepted: this.accepted,
      rejected: this.rejected,
      // 无到达样本时经验阻塞比例定义为 0
      blockingProbability:
        totalArrivals > 0 ? this.rejected / totalArrivals : 0,
      ...averages,
      effectiveArrivalRate: horizon > 0 ? this.accepted / horizon : 0,
    };
  }
}

/** 构造一个可分段推进的仿真实例（内部同时完成入参校验） */
export function createSimulation(input: SimulationInput): SimulationRunner {
  return new SimulationRunner(input);
}

/** 一次性跑完整个仿真：等价于连续 step 到停止后 finish */
export function runSimulation(rawInput: SimulationInput): SimulationResult {
  const runner = new SimulationRunner(rawInput);
  while (runner.step()) {
    // 单线程直跑：不在事件之间让出，保持与历史实现相同的调度与耗时
  }
  return runner.finish();
}
