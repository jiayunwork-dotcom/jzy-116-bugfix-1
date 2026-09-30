/**
 * 公共类型定义。
 *
 * 模型语义（解析与仿真共用，不得各说各话）：
 * - 这是 M/M/1/K 有限容量单服务台排队；
 * - 系统状态 n = 当前系统内顾客数，取值 0..K，n 已经把正在被服务的那一个算进去；
 * - 容量 K = capacity，是“系统总容量”，不是排队区缓冲槽位数；
 * - n === K 时新到达的顾客立即拒绝（阻塞 / 丢弃），不进入系统。
 */

/** 排队模型的三要素 */
export interface QueueParams {
  /** 名义到达率 λ（单位时间顾客数，> 0） */
  lambda: number;
  /** 服务率 μ（单位时间顾客数，> 0） */
  mu: number;
  /** 系统总容量 K（正整数，含正在服务的 1 个） */
  capacity: number;
}

/** 稳态解析结果 */
export interface AnalyticResult extends QueueParams {
  /** 业务强度 ρ = λ / μ */
  rho: number;
  /** 稳态状态概率 π_n，n = 0..K，下标即系统内顾客数 */
  stateProbabilities: number[];
  /** 阻塞概率 = 满员状态概率 π_K */
  blockingProbability: number;
  /** 有效到达率 λ_e = λ(1 - π_K) */
  effectiveArrivalRate: number;
  /** 利用率 = λ_e / μ = 1 - π_0（服务台忙的时间比例） */
  utilization: number;
  /** 平均队长 L：系统内平均顾客数（含服务中的 1 个） */
  meanNumberInSystem: number;
  /** 平均排队等待人数 L_q：不含服务中的顾客 */
  meanNumberWaiting: number;
  /** 平均逗留时间 W = L / λ_e；λ_e 为 0 时定义为 0（不返回无穷） */
  meanTimeInSystem: number;
  /** 平均排队等待时间 W_q = L_q / λ_e；λ_e 为 0 时定义为 0 */
  meanWaitingTime: number;
}

/** 仿真入参 */
export interface SimulationInput extends QueueParams {
  /** 随机数种子（0..2^32-1 的整数），同种子两次运行结果完全一致 */
  seed: number;
  /** 停止条件之一：抽样的到达尝试（含被拒绝的）顾客数达到该值 */
  maxArrivals?: number;
  /** 停止条件之一：仿真时钟到达该时刻 */
  maxTime?: number;
}

/** 离散事件仿真结果 */
export interface SimulationResult extends QueueParams {
  /** 实际使用的种子 */
  seed: number;
  /** 固定的随机数发生器算法标识 */
  rngAlgorithm: 'mulberry32';
  /** 实际触发的停止条件 */
  stopReason: 'maxArrivals' | 'maxTime';
  /** 仿真结束时刻（统计时域长度） */
  endTime: number;
  /** 抽样到的到达尝试总数（含被拒绝的） */
  totalArrivals: number;
  /** 被接纳进入系统的顾客数 */
  accepted: number;
  /** 系统满员时被直接丢弃的顾客数 */
  rejected: number;
  /** 经验阻塞比例 = rejected / totalArrivals（无到达样本时定义为 0） */
  blockingProbability: number;
  /** 经验平均队长：系统内顾客数的时间加权平均（含服务中） */
  meanNumberInSystem: number;
  /** 经验平均排队等待人数：max(n-1, 0) 的时间加权平均 */
  meanNumberWaiting: number;
  /** 经验利用率：服务台忙的时间比例 */
  utilization: number;
  /** 经验有效到达率 = accepted / endTime */
  effectiveArrivalRate: number;
}

/** 单项指标的两边对照 */
export interface MetricComparison {
  analytic: number;
  simulation: number;
  /** 绝对差 |解析 - 仿真| */
  absoluteDifference: number;
}

/** 一次性对照接口的返回 */
export interface CompareResult {
  input: SimulationInput;
  analytic: AnalyticResult;
  simulation: SimulationResult;
  comparison: {
    blockingProbability: MetricComparison;
    meanNumberInSystem: MetricComparison;
    utilization: MetricComparison;
  };
}
