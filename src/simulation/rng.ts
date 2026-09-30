/**
 * 固定算法的伪随机数发生器。
 *
 * 算法：mulberry32（32 位整数状态的快速 PRNG）。算法名一并写进响应里，
 * 只要算法标识不变，同一 seed 跑出的随机数序列（进而仿真结果）就不会变。
 * 两阶段抽样：mulberry32 产出 (0,1) 上的均匀数，再经逆变换得到指数分布。
 */
export class Rng {
  private state: number;
  readonly algorithm = 'mulberry32' as const;

  constructor(seed: number) {
    // seed 已在输入校验中保证为 uint32；这里 >>> 0 再做一次防御性归一
    this.state = seed >>> 0;
  }

  /** 返回 (0,1) 上的均匀随机数；理论上 mulberry32 不会返回精确的 0/1 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * 参数为 rate 的指数分布抽样，均值 1/rate：
   * X = -ln(U)/rate。next() 落在 (0,1)，故不会出现 log(0)。
   */
  exponential(rate: number): number {
    return -Math.log(this.next()) / rate;
  }
}
