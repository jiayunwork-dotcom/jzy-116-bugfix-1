import type {
  AnalyticResult,
  MetricComparison,
  SimulationResult,
} from '../types.js';

/**
 * 时间加权统计累加器。
 *
 * 离散事件仿真里，两次相邻事件之间系统状态保持不变，所以“时间平均值”
 * 等于状态对时间的积分（累积成面积）除以总时长。同一个 accumulator
 * 同时登记：
 * - 系统内总人数 n（含服务中的顾客）；
 * - 排队等待人数 max(n - 1, 0)（不含服务中的顾客）；
 * - 服务台忙闲指示 1{n > 0}。
 */
export class TimeWeightedAccumulator {
  private areaSystem = 0;
  private areaWaiting = 0;
  private areaBusy = 0;
  private currentSystem = 0;
  private lastTime = 0;
  private started = false;

  /** 在事件时刻 newTime 把状态更新为 newSystem */
  observe(newTime: number, newSystem: number): void {
    if (this.started) {
      const dt = newTime - this.lastTime;
      if (dt < 0) throw new Error('观测时刻必须非递减');
      this.areaSystem += this.currentSystem * dt;
      this.areaWaiting += Math.max(this.currentSystem - 1, 0) * dt;
      this.areaBusy += this.currentSystem > 0 ? dt : 0;
    }
    this.currentSystem = newSystem;
    this.lastTime = newTime;
    this.started = true;
  }

  /** 补上 [最后事件时刻, horizon] 这段无事件区间并返回汇总指标 */
  settle(horizon: number): {
    meanNumberInSystem: number;
    meanNumberWaiting: number;
    utilization: number;
  } {
    if (!this.started) {
      // 仿真时域内没有任何事件发生：所有时间平均值按 0 处理
      return {
        meanNumberInSystem: 0,
        meanNumberWaiting: 0,
        utilization: 0,
      };
    }
    this.observe(horizon, this.currentSystem);
    if (horizon <= 0) {
      return {
        meanNumberInSystem: 0,
        meanNumberWaiting: 0,
        utilization: 0,
      };
    }
    return {
      meanNumberInSystem: this.areaSystem / horizon,
      meanNumberWaiting: this.areaWaiting / horizon,
      utilization: this.areaBusy / horizon,
    };
  }
}

/** 单项指标的解析/仿真绝对差 */
export function compareMetric(
  analytic: number,
  simulation: number,
): MetricComparison {
  return {
    analytic,
    simulation,
    absoluteDifference: Math.abs(analytic - simulation),
  };
}

/** 三样核心指标的对照表 */
export function buildComparison(
  analytic: AnalyticResult,
  simulation: SimulationResult,
) {
  return {
    blockingProbability: compareMetric(
      analytic.blockingProbability,
      simulation.blockingProbability,
    ),
    meanNumberInSystem: compareMetric(
      analytic.meanNumberInSystem,
      simulation.meanNumberInSystem,
    ),
    utilization: compareMetric(analytic.utilization, simulation.utilization),
  };
}
