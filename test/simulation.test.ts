import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSimulation } from '../src/simulation/engine.js';
import { Rng } from '../src/simulation/rng.js';
import { parseSimulationInput } from '../src/validation/validation.js';
import { analyzeQueue } from '../src/analytics/analytic.js';

test('RNG 算法固定：mulberry32(seed=42) 的前 5 个均匀数与指数样本', () => {
  const rng = new Rng(42);
  const expectedUniform = [
    0.6011037519201636, 0.44829055899754167, 0.8524657934904099,
    0.6697340414393693, 0.17481389874592423,
  ];
  for (const expected of expectedUniform) {
    assert.ok(Math.abs(rng.next() - expected) < 1e-15);
  }
  const rng2 = new Rng(42);
  const expectedExp5 = [
    0.1017975454398898, 0.16046273752126283, 0.03192443911348554,
    0.08017491969588426, 0.3488066613290362,
  ];
  for (const expected of expectedExp5) {
    assert.ok(Math.abs(rng2.exponential(5) - expected) < 1e-15);
  }
});

test('同种子两次运行结果完全一致；不同种子一般不同', () => {
  const input = {
    lambda: 8,
    mu: 10,
    capacity: 5,
    seed: 12345,
    maxArrivals: 20_000,
  };
  const a = runSimulation(input);
  const b = runSimulation(input);
  assert.deepEqual(a, b);

  const c = runSimulation({ ...input, seed: 12346 });
  assert.notDeepEqual(a, c);
});

test('满员即丢弃：accepted + rejected = 总到达尝试数', () => {
  const r = runSimulation({
    lambda: 50, // 远大于服务率，大量拒绝
    mu: 1,
    capacity: 2,
    seed: 7,
    maxArrivals: 10_000,
  });
  assert.equal(r.accepted + r.rejected, r.totalArrivals);
  assert.equal(r.totalArrivals, 10_000);
  assert.equal(r.stopReason, 'maxArrivals');
  assert.ok(r.rejected > 0);
  assert.ok(
    Math.abs(r.blockingProbability - r.rejected / r.totalArrivals) < 1e-15,
  );
});

test('仿真与解析互相印证：经验阻塞比例、利用率、平均队长落入容差', () => {
  // λ=8、μ=10（ρ=0.8）、K=2，解析阻塞概率约 0.2623，样本量 50 万
  const params = { lambda: 8, mu: 10, capacity: 2 };
  const input = { ...params, seed: 20240901, maxArrivals: 500_000 };
  const analytic = analyzeQueue(params);
  const sim = runSimulation(input);

  assert.equal(sim.rngAlgorithm, 'mulberry32');
  assert.equal(sim.stopReason, 'maxArrivals');
  assert.equal(sim.totalArrivals, 500_000);

  // π_2 = (1-0.8)0.8^2/(1-0.8^3) ≈ 0.2623
  assert.ok(Math.abs(analytic.blockingProbability - 0.262295) < 1e-5);

  assert.ok(
    Math.abs(sim.blockingProbability - analytic.blockingProbability) < 0.02,
    `阻塞：sim=${sim.blockingProbability} analytic=${analytic.blockingProbability}`,
  );
  assert.ok(
    Math.abs(sim.utilization - analytic.utilization) < 0.02,
    `利用率：sim=${sim.utilization} analytic=${analytic.utilization}`,
  );
  assert.ok(
    Math.abs(sim.meanNumberInSystem - analytic.meanNumberInSystem) < 0.05,
    `队长：sim=${sim.meanNumberInSystem} analytic=${analytic.meanNumberInSystem}`,
  );
  // 指标的物理边界
  assert.ok(sim.utilization >= 0 && sim.utilization <= 1);
  assert.ok(sim.meanNumberInSystem >= 0 && sim.meanNumberInSystem <= 2);
});

test('长仿真（固定种子）经验阻塞比例严格收敛到解析满员概率：ρ<1、=1、>1', () => {
  // 样本量 100 万、K=2，阻塞比例标准误约 sqrt(p(1-p)/N) ≤ 0.0005，
  // 5 倍标准差上界约 0.0025，取 0.005 容差
  const cases = [
    { lambda: 8, mu: 10 }, // ρ=0.8
    { lambda: 10, mu: 10 }, // ρ=1，均匀分布 P_block=1/3
    { lambda: 12, mu: 10 }, // ρ=1.2
  ];
  for (const params of cases) {
    const analytic = analyzeQueue({ ...params, capacity: 2 });
    const sim = runSimulation({
      ...params,
      capacity: 2,
      seed: 777,
      maxArrivals: 1_000_000,
    });
    assert.ok(
      Math.abs(sim.blockingProbability - analytic.blockingProbability) < 0.005,
      `ρ=${params.lambda / params.mu}: sim=${sim.blockingProbability} analytic=${analytic.blockingProbability}`,
    );
    assert.ok(
      Math.abs(sim.utilization - analytic.utilization) < 0.005,
      `ρ=${params.lambda / params.mu} 利用率`,
    );
    assert.ok(
      Math.abs(sim.meanNumberInSystem - analytic.meanNumberInSystem) < 0.02,
      `ρ=${params.lambda / params.mu} 队长`,
    );
  }
});

test('maxTime 停止条件同样收敛到解析值', () => {
  // λ/μ=0.6、K=3；速率同比例放大 100 倍，跑 400 个时间单位，
  // 期望到达尝试数 ≈ 600*400 = 24 万
  const params = { lambda: 600, mu: 1000, capacity: 3 };
  const analytic = analyzeQueue({ lambda: 6, mu: 10, capacity: 3 });
  const sim = runSimulation({
    ...params,
    seed: 99,
    maxTime: 400,
  });
  assert.equal(sim.stopReason, 'maxTime');
  assert.ok(sim.endTime <= 400 + 1e-9);
  assert.ok(sim.totalArrivals > 100_000);
  assert.ok(
    Math.abs(sim.blockingProbability - analytic.blockingProbability) < 0.02,
  );
  assert.ok(Math.abs(sim.utilization - analytic.utilization) < 0.02);
});

test('入参校验：非正速率、非正整数容量、缺停止条件均报错', () => {
  assert.throws(() =>
    parseSimulationInput({ lambda: 0, mu: 1, capacity: 3, seed: 1, maxArrivals: 10 }),
  );
  assert.throws(() =>
    parseSimulationInput({ lambda: 1, mu: 0, capacity: 3, seed: 1, maxArrivals: 10 }),
  );
  assert.throws(() =>
    parseSimulationInput({ lambda: 1, mu: 1, capacity: 1.5, seed: 1, maxArrivals: 10 }),
  );
  assert.throws(() =>
    parseSimulationInput({ lambda: 1, mu: 1, capacity: 3, seed: 1 }),
  );
  assert.throws(() =>
    parseSimulationInput({ lambda: 1, mu: 1, capacity: 3, seed: -1, maxTime: 10 }),
  );
});

test('默认种子为 1 且不带种子时结果确定', () => {
  const parsed = parseSimulationInput({
    lambda: 3,
    mu: 4,
    capacity: 2,
    maxArrivals: 100,
  });
  assert.equal(parsed.seed, 1);
  assert.deepEqual(runSimulation(parsed), runSimulation(parsed));
});
