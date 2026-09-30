import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeQueue,
  steadyStateDistribution,
  deriveMetrics,
} from '../src/analytics/analytic.js';

const EPS = 1e-12;

test('稳态概率构成几何级数：π_n = π_0 ρ^n（ρ≠1）', () => {
  const rho = 0.6;
  const K = 5;
  const p = steadyStateDistribution(rho, K);
  assert.equal(p.length, K + 1);
  const pi0 = p[0];
  for (let n = 0; n <= K; n++) {
    assert.ok(Math.abs(p[n] - pi0 * rho ** n) < 1e-12, `n=${n}`);
  }
  // 概率归一
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

test('ρ=1 退化为均匀分布', () => {
  const K = 9;
  const p = steadyStateDistribution(1, K);
  for (const x of p) assert.ok(Math.abs(x - 1 / (K + 1)) < 1e-12);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);

  // 经完整接口走一遍也应对称
  const r = analyzeQueue({ lambda: 3, mu: 3, capacity: K });
  assert.ok(Math.abs(r.blockingProbability - 1 / (K + 1)) < 1e-12);
});

test('阻塞概率=满员概率，利用率=1-π0=λ_e/μ', () => {
  const r = analyzeQueue({ lambda: 8, mu: 10, capacity: 4 });
  assert.equal(r.stateProbabilities.length, 5);
  assert.ok(Math.abs(r.blockingProbability - r.stateProbabilities[4]) < EPS);
  assert.ok(
    Math.abs(
      r.utilization -
        (1 - r.stateProbabilities[0]),
    ) < EPS,
  );
  assert.ok(
    Math.abs(
      r.effectiveArrivalRate - 8 * (1 - r.blockingProbability),
    ) < EPS,
  );
  assert.ok(Math.abs(r.utilization - r.effectiveArrivalRate / 10) < EPS);
  // 平均队长 = Σ n π_n
  const manualL = r.stateProbabilities.reduce((acc, p, n) => acc + n * p, 0);
  assert.ok(Math.abs(r.meanNumberInSystem - manualL) < EPS);
  // 平均逗留时间 = L / λ_e
  assert.ok(
    Math.abs(r.meanTimeInSystem - r.meanNumberInSystem / r.effectiveArrivalRate) <
      EPS,
  );
});

test('K=1（无排队区）：只有 0/1 两个状态', () => {
  const r = analyzeQueue({ lambda: 2, mu: 3, capacity: 1 });
  // π0 = μ/(λ+μ) = 0.6，π1 = λ/(λ+μ) = 0.4
  assert.ok(Math.abs(r.stateProbabilities[0] - 0.6) < 1e-12);
  assert.ok(Math.abs(r.stateProbabilities[1] - 0.4) < 1e-12);
  assert.ok(Math.abs(r.blockingProbability - 0.4) < 1e-12);
  assert.ok(Math.abs(r.utilization - 0.4) < 1e-12);
});

test('阻塞概率关于容量单调不增：容量调大只能下降不能上升', () => {
  const cases: Array<{ lambda: number; mu: number }> = [
    { lambda: 8, mu: 10 }, // ρ<1
    { lambda: 10, mu: 10 }, // ρ=1
    { lambda: 12, mu: 10 }, // ρ>1，数值更易溢出，一并锁
  ];
  for (const { lambda, mu } of cases) {
    let previous = 1;
    for (let K = 1; K <= 60; K++) {
      const pBlock = analyzeQueue({ lambda, mu, capacity: K })
        .blockingProbability;
      assert.ok(
        pBlock <= previous + EPS,
        `λ=${lambda}, μ=${mu}: P_block(${K})=${pBlock} > P_block(${K - 1})=${previous}`,
      );
      previous = pBlock;
    }
  }
});

test('同比例放大 λ、μ（比值不变）：状态分布形状不变', () => {
  const K = 8;
  const base = analyzeQueue({ lambda: 3, mu: 5, capacity: K });
  for (const scale of [0.5, 2, 10, 1000]) {
    const scaled = analyzeQueue({
      lambda: 3 * scale,
      mu: 5 * scale,
      capacity: K,
    });
    for (let n = 0; n <= K; n++) {
      assert.ok(
        Math.abs(base.stateProbabilities[n] - scaled.stateProbabilities[n]) <
          1e-12,
        `scale=${scale}, n=${n}`,
      );
    }
    assert.ok(
      Math.abs(base.blockingProbability - scaled.blockingProbability) < 1e-12,
    );
    // 利用率只依赖比值
    assert.ok(Math.abs(base.utilization - scaled.utilization) < 1e-12);
  }
});

test('大 ρ 大 K 不产生 NaN/Infinity（几何级数溢出保护）', () => {
  const r = analyzeQueue({ lambda: 100, mu: 1, capacity: 500 });
  for (const p of r.stateProbabilities) {
    assert.ok(Number.isFinite(p));
    assert.ok(p >= 0 && p <= 1);
  }
  assert.ok(
    Math.abs(r.stateProbabilities.reduce((a, b) => a + b, 0) - 1) < 1e-9,
  );
  assert.ok(Number.isFinite(r.meanNumberInSystem));
});

test('回归算例：ρ<1、K 足够大时平均队长接近无限容量闭式 L=ρ/(1-ρ)、W=1/(μ-λ)', () => {
  // 预置场景：λ=0.8、μ=1（ρ=0.8），K=200 时阻塞概率实际为 0
  const lambda = 0.8;
  const mu = 1;
  const K = 200;
  const r = analyzeQueue({ lambda, mu, capacity: K });

  const infiniteL = lambda / (mu - lambda); // 0.8/0.2 = 4
  const infiniteW = 1 / (mu - lambda); // 5
  assert.ok(
    Math.abs(infiniteL - 4) < EPS && Math.abs(infiniteW - 5) < EPS,
    '经典闭式参考值本身',
  );
  assert.ok(
    Math.abs(r.meanNumberInSystem - infiniteL) < 1e-12,
    `有限容量 L=${r.meanNumberInSystem} 应收敛到 ${infiniteL}`,
  );
  assert.ok(
    Math.abs(r.meanTimeInSystem - infiniteW) < 1e-12,
    `W=${r.meanTimeInSystem} 应收敛到 ${infiniteW}`,
  );
  assert.ok(
    Math.abs(r.utilization - 0.8) < 1e-12,
    'ρ<1 无限容量极限下利用率=ρ',
  );
  assert.ok(r.blockingProbability < 1e-15, 'K=200 时阻塞概率应可忽略');
});

test('极端情形：有效到达率为 0 时逗留时间定义为 0，不返回无穷', () => {
  // 直接构造 π_1=1 的退化稳态（任何到达都被阻塞）来锁定除零语义
  const m = deriveMetrics({ lambda: 5, mu: 3, capacity: 1 }, [0, 1]);
  assert.equal(m.blockingProbability, 1);
  assert.equal(m.effectiveArrivalRate, 0);
  assert.equal(m.utilization, 0);
  assert.equal(m.meanTimeInSystem, 0);
  assert.equal(m.meanWaitingTime, 0);
});

test('非法输入抛错', () => {
  assert.throws(() => analyzeQueue({ lambda: 0, mu: 1, capacity: 3 }));
  assert.throws(() => analyzeQueue({ lambda: 1, mu: -1, capacity: 3 }));
  assert.throws(() => analyzeQueue({ lambda: 1, mu: 1, capacity: 0 }));
  assert.throws(() => analyzeQueue({ lambda: 1, mu: 1, capacity: 2.5 }));
});
