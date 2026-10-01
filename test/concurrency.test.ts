import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { availableParallelism } from 'node:os';
import { createApp } from '../src/app.js';
import {
  SimulationPool,
  SimulationAbortedError,
  SimulationFailedError,
  getSimulationPool,
} from '../src/simulation/pool.js';
import type { SimulationResult } from '../src/types.js';

/**
 * 长时域并发回归用例。
 *
 * 这组测试刻意使用真实量级的长仿真（maxTime 2e7 / 5e7，单机数秒），
 * 因为短仿真在修复前后“感觉”一样，只有长仿真才能暴露事件循环被独占、
 * 断开不感知、多作业首尾串行这些问题。
 */

let server: Server;
let base: string;

const BIG_50M = { lambda: 1, mu: 1.25, capacity: 20, seed: 42, maxTime: 50_000_000 };
const PARALLEL_BODY = (seed: number) => ({
  lambda: 1,
  mu: 1.25,
  capacity: 20,
  seed,
  maxTime: 20_000_000,
});

/**
 * seed=1 / seed=2、maxTime=2e7 的“单独运行”历史快照（逐字段、逐位）。
 * 它们是在主线程一次性跑完 runSimulation 得到、随后固化的基准：
 * 并发执行的结果必须与这些快照 deepEqual，任何字段/位差异都视为回归。
 */
const SOLO_GOLDEN: Record<number, SimulationResult> = {
  1: {
    lambda: 1,
    mu: 1.25,
    capacity: 20,
    seed: 1,
    rngAlgorithm: 'mulberry32',
    stopReason: 'maxTime',
    endTime: 20_000_000,
    totalArrivals: 19_992_752,
    accepted: 19_945_881,
    rejected: 46_871,
    blockingProbability: 0.002344399610418816,
    meanNumberInSystem: 3.801104483782428,
    meanNumberWaiting: 3.0030850056531215,
    utilization: 0.7980194781282924,
    effectiveArrivalRate: 0.99729405,
  },
  2: {
    lambda: 1,
    mu: 1.25,
    capacity: 20,
    seed: 2,
    rngAlgorithm: 'mulberry32',
    stopReason: 'maxTime',
    endTime: 20_000_000,
    totalArrivals: 19_998_374,
    accepted: 19_951_361,
    rejected: 47_013,
    blockingProbability: 0.002350841123383331,
    meanNumberInSystem: 3.8042750604520283,
    meanNumberWaiting: 3.0060749523819643,
    utilization: 0.7982001080704729,
    effectiveArrivalRate: 0.99756805,
  },
};

before(async () => {
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取监听地址');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  // 回收进程级仿真池的全部 worker，避免空闲线程让测试进程挂住不退出
  await getSimulationPool().shutdown();
});

async function postJson(path: string, body: unknown, init?: RequestInit) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

// Node 20 的 fetch 把响应体标成 unknown，测试里按仿真结果结构读取
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readSim(path: string, body: unknown, init?: RequestInit): Promise<any> {
  const r = await postJson(path, body, init);
  return r.json();
}

test('长仿真期间健康检查与纯解析请求仍在 200ms 内应答，且 5e7 请求被接受且结果逐位正确', async () => {
  // 先发起一个约 7 秒的长仿真，不等它
  const longTask = readSim('/api/simulation', BIG_50M);

  // 等它确实进入运行状态
  await new Promise((r) => setTimeout(r, 1000));

  const healthStart = performance.now();
  const health = await fetch(`${base}/health`);
  const healthMs = performance.now() - healthStart;
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const analyticStart = performance.now();
  const analytic = await postJson('/api/analytic', {
    lambda: 1,
    mu: 1.25,
    capacity: 4,
  });
  const analyticMs = performance.now() - analyticStart;
  assert.equal(analytic.status, 200);
  await analytic.json();

  // 核心断言：长仿真在跑，短请求不被拖住
  assert.ok(
    healthMs < 200,
    `健康检查耗时 ${healthMs.toFixed(1)}ms，应 < 200ms`,
  );
  assert.ok(
    analyticMs < 200,
    `纯解析请求耗时 ${analyticMs.toFixed(1)}ms，应 < 200ms`,
  );

  // 时长上限没有被压低：5e7 照样受理，且数字与历史登记逐位一致
  const result = await longTask;
  assert.equal(result.totalArrivals, 49_992_828);
  assert.equal(result.rejected, 119_053);
  assert.equal(result.endTime, 50_000_000);
  assert.equal(result.stopReason, 'maxTime');
  assert.equal(result.accepted + result.rejected, result.totalArrivals);
  assert.ok(Math.abs(result.blockingProbability - 0.002381401588243818) < 1e-18);
});

test('客户端断开后，对应的仿真在短时间内停下并释放算力，后续请求不被拖住', async () => {
  // —— 第一层：直接对线程度，验证“被放弃的计算”得到的是结构化拒绝而非正常结果 ——
  const pool = new SimulationPool(1); // 单 worker：若计算不停，后续作业必然被堵
  const controller = new AbortController();
  const job = pool.run(
    { lambda: 1, mu: 1.25, capacity: 20, seed: 42, maxTime: 50_000_000 },
    controller.signal,
  );

  await new Promise((r) => setTimeout(r, 300));
  const abortAt = performance.now();
  controller.abort();
  await assert.rejects(
    job,
    (err: unknown) => {
      assert.ok(err instanceof SimulationAbortedError);
      return true;
    },
  );
  const abortMs = performance.now() - abortAt;
  // 自然跑完要约 7 秒；这里必须在一个分片窗口（约几十毫秒）内拒绝
  assert.ok(
    abortMs < 1000,
    `断开后 ${abortMs.toFixed(0)}ms 才停下，应在分片边界（<1000ms）内停止`,
  );

  // 算力已释放：同一个单 worker 池上的下一单立刻能跑（若旧计算没停，
  // 这里要等到约 7 秒以后）
  const followStart = performance.now();
  const follow = await pool.run(
    { lambda: 8, mu: 10, capacity: 4, seed: 1, maxArrivals: 100_000 },
    new AbortController().signal,
  );
  const followMs = performance.now() - followStart;
  assert.equal(follow.totalArrivals, 100_000);
  assert.ok(
    followMs < 2000,
    `被放弃的计算似乎仍在占用 worker：后续作业耗时 ${followMs.toFixed(0)}ms`,
  );
  await pool.shutdown();

  // —— 第二层：经 HTTP 真实断开，验证随后的健康检查不被拖住 ——
  const httpController = new AbortController();
  const httpJob = postJson('/api/simulation', BIG_50M, {
    signal: httpController.signal,
  });
  await new Promise((r) => setTimeout(r, 300));
  httpController.abort();
  await assert.rejects(httpJob, (err: unknown) => {
    assert.equal((err as Error).name, 'AbortError');
    return true;
  });

  // 给服务端一个分片边界的时间处理取消
  await new Promise((r) => setTimeout(r, 200));
  const healthStart = performance.now();
  const health = await fetch(`${base}/health`);
  const healthMs = performance.now() - healthStart;
  assert.equal(health.status, 200);
  assert.ok(
    healthMs < 200,
    `断开后的健康检查耗时 ${healthMs.toFixed(1)}ms，应 < 200ms`,
  );
});

test('两个长对照请求并发提交：结果与各自单独运行逐位一致，且互不串行', async () => {
  // 测量单独耗时之和，作为“首尾相接”的基线
  const soloTimings: number[] = [];
  for (const seed of [1, 2]) {
    const t0 = performance.now();
    const r = await postJson('/api/compare', PARALLEL_BODY(seed));
    soloTimings.push(performance.now() - t0);
    assert.equal(r.status, 200);
    await r.json();
  }

  // 两个长对照同时提交；并发期间再插一个纯解析请求，验证短请求不跟排
  const parallelStart = performance.now();
  let analyticMs = 0;
  const analyticProbe = new Promise<void>(async (resolve) => {
    await new Promise((r) => setTimeout(r, 500)); // 等两个长作业都已开始
    const t0 = performance.now();
    const r = await postJson('/api/analytic', { lambda: 1, mu: 1.25, capacity: 4 });
    analyticMs = performance.now() - t0;
    assert.equal(r.status, 200);
    resolve();
  });

  const [c1, c2] = await Promise.all(
    [1, 2].map(async (seed) => {
      const r = await postJson('/api/compare', PARALLEL_BODY(seed));
      assert.equal(r.status, 200);
      return (await r.json()) as {
        simulation: SimulationResult;
        analytic: { rho: number };
        comparison: {
          blockingProbability: { absoluteDifference: number };
        };
      };
    }),
  );
  const parallelMs = performance.now() - parallelStart;
  await analyticProbe;

  // 逐字段、逐位一致：每个结果与该 seed 单独运行的历史快照完全相同
  assert.deepEqual(c1.simulation as SimulationResult, SOLO_GOLDEN[1]);
  assert.deepEqual(c2.simulation as SimulationResult, SOLO_GOLDEN[2]);
  // 两个交错执行的作业随机数序列/统计量各自独立，没有串线
  assert.notDeepEqual(c1.simulation, c2.simulation);
  // 对照结构字段照常产出
  assert.ok(c1.comparison.blockingProbability.absoluteDifference >= 0);
  assert.ok(c2.analytic.rho === 0.8);

  // 短请求不跟在长请求后面排队
  assert.ok(
    analyticMs < 200,
    `并发期间纯解析请求耗时 ${analyticMs.toFixed(1)}ms，应 < 200ms`,
  );

  // CPU 核数充足时，并发总耗时应明显小于单独耗时之和（真并行而非首尾相接）。
  // 核数不足（如单核容器）时只验证“短请求不被拖住”，不对墙钟作硬断言。
  if (availableParallelism() >= 3) {
    const soloSum = soloTimings[0] + soloTimings[1];
    assert.ok(
      parallelMs < soloSum * 0.85,
      `并发 ${parallelMs.toFixed(0)}ms 未明显短于串行之和 ${soloSum.toFixed(0)}ms`,
    );
  }
});

test('并发上限：排队中的作业被取消时立即放弃，不占用 worker，也不返回正常结果', async () => {
  const pool = new SimulationPool(1);
  const longInput = {
    lambda: 1,
    mu: 1.25,
    capacity: 20,
    seed: 42,
    maxTime: 50_000_000,
  };

  // 占住唯一的 worker
  const runningController = new AbortController();
  const running = pool.run(longInput, runningController.signal);

  // 第二个作业只能排队；在它开始前取消
  const queuedController = new AbortController();
  const queued = pool.run(
    { ...longInput, seed: 7 },
    queuedController.signal,
  );
  await new Promise((r) => setTimeout(r, 100));
  queuedController.abort();

  await assert.rejects(queued, (err: unknown) => {
    assert.ok(err instanceof SimulationAbortedError);
    return true;
  });

  // 正在跑的作业不受排队作业取消影响，正常完成且结果正确
  const result = await running;
  assert.equal(result.totalArrivals, 49_992_828);
  await pool.shutdown();
});

test('关闭中进行的作业以结构化错误结束，进程不会挂掉或静默吞掉', async () => {
  const pool = new SimulationPool(1);
  const controller = new AbortController();
  const job = pool.run(
    { lambda: 1, mu: 1.25, capacity: 20, seed: 42, maxTime: 50_000_000 },
    controller.signal,
  );
  await new Promise((r) => setTimeout(r, 200));
  // 服务关闭：终止 worker，作业必须 reject（aborted 或 failed），绝不 resolve 半截结果
  const shutdown = pool.shutdown();
  await assert.rejects(
    job,
    (err: unknown) =>
      err instanceof SimulationAbortedError || err instanceof SimulationFailedError,
  );
  await shutdown;
});
