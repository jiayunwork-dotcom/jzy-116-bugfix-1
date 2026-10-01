import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { SimulationWorkerPool } from '../src/simulation/worker-pool.js';
import { runSimulation } from '../src/simulation/engine.js';

/**
 * 长仿真并发回归测试。三件必须守住的事：
 *   1. 长仿真跑满 CPU 期间，健康检查与纯解析请求仍在 200ms 内应答；
 *   2. 调用方断开连接后，对应计算在短时间内真正停下，随后的请求不被拖住；
 *   3. 多组仿真并发提交时，各自结果与单独运行逐位一致，随机数序列互不串扰。
 *
 * 这些用例刻意起真实 HTTP server、真实工作线程、真实断连，而不是 mock。
 */

// 复现用例：到达率 1、服务率 1.25、容量 20、种子 42、时长 5e7（约 6~7 秒）
const LONG = { lambda: 1, mu: 1.25, capacity: 20, seed: 42, maxTime: 50_000_000 } as const;
// 对照用例：时长 2e7，种子 1 / 2（单独各约 2.5~3 秒）
const PAIR_SEEDS = [1, 2] as const;
const PAIR_MAX_TIME = 20_000_000;

const HEALTH_BUDGET_MS = 200;

// “单独运行”的逐位基准与墙钟耗时（同步跑在主线程，作为对照真值），
// 模块加载时一次性算好，避免每个用例各付一遍长仿真。
let longSoloMs: number;
const longGolden: ReturnType<typeof runSimulation> = (() => {
  const t = Date.now();
  const golden = runSimulation({ ...LONG });
  longSoloMs = Date.now() - t;
  return golden;
})();

const pairGolden: Array<{ golden: ReturnType<typeof runSimulation>; soloMs: number }> = [];
for (const seed of PAIR_SEEDS) {
  const t0 = Date.now();
  const golden = runSimulation({
    lambda: LONG.lambda,
    mu: LONG.mu,
    capacity: LONG.capacity,
    seed,
    maxTime: PAIR_MAX_TIME,
  });
  pairGolden.push({ golden, soloMs: Date.now() - t0 });
}



function startServer(workerCount: number) {
  const pool = new SimulationWorkerPool(workerCount);
  const server = createApp(pool).listen(0, '127.0.0.1');
  const base = new Promise<string>((resolve, reject) => {
    server.once('listening', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('无法获取监听地址'));
      resolve(`http://127.0.0.1:${addr.port}`);
    });
    server.once('error', reject);
  });
  return { pool, server, base };
}

async function stopServer(server: Server, pool: SimulationWorkerPool) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.destroy();
}

async function postJson(base: string, path: string, body: unknown, init?: RequestInit) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

// Node 20 的 fetch 类型把响应体标成 unknown，测试里按宽松结构读取
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<any> {
  return res.json();
}

test('1) 长仿真期间 /health 与纯解析请求在 200ms 内应答，长仿真结果逐位不变', async () => {
  // 单 worker：长仿真把那个 worker 占满，正好检验主线程是否仍畅通
  const { pool, server, base: baseUrl } = startServer(1);
  const base = await baseUrl;

  try {
    // 提交长仿真（约 6~7 秒），不 await
    const longPromise = postJson(base, '/api/simulation', { ...LONG });

    // 等它确实在 worker 上跑起来
    await new Promise((r) => setTimeout(r, 1000));

    // 长仿真运行期间，健康检查必须及时
    const healthTimings: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const t0 = Date.now();
      const res = await fetch(`${base}/health`);
      const elapsed = Date.now() - t0;
      healthTimings.push(elapsed);
      assert.equal(res.status, 200);
      assert.deepEqual(await readJson(res), { status: 'ok' });
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(
      Math.max(...healthTimings) < HEALTH_BUDGET_MS,
      `健康检查延迟 ${JSON.stringify(healthTimings)} 超过 ${HEALTH_BUDGET_MS}ms`,
    );

    // 同一时刻纯解析（capacity=4）也必须及时（平时约 2ms）
    const analyticTimings: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const t0 = Date.now();
      const res = await postJson(base, '/api/analytic', {
        lambda: LONG.lambda,
        mu: LONG.mu,
        capacity: 4,
      });
      const elapsed = Date.now() - t0;
      analyticTimings.push(elapsed);
      assert.equal(res.status, 200);
      const body = await readJson(res);
      assert.equal(body.stateProbabilities.length, 5);
    }
    assert.ok(
      Math.max(...analyticTimings) < HEALTH_BUDGET_MS,
      `解析请求延迟 ${JSON.stringify(analyticTimings)} 超过 ${HEALTH_BUDGET_MS}ms`,
    );

    // 长仿真最终结果必须与单独运行逐位一致（并发、让出执行机会都不改变结果）
    const longRes = await longPromise;
    assert.equal(longRes.status, 200);
    const longBody = await readJson(longRes);
    assert.deepEqual(longBody, longGolden);
    assert.equal(longBody.totalArrivals, 49_992_828);
    assert.equal(longBody.rejected, 119_053);
  } finally {
    await stopServer(server, pool);
  }
});

test('2) 调用方断开后运行中的仿真很快停下，后续仿真不再被拖住', async () => {
  // 单 worker：若取消不生效，后续任务只能等约 6~7 秒
  const { pool, server, base: baseUrl } = startServer(1);
  const base = await baseUrl;

  try {
    const controller = new AbortController();
    const startedAt = Date.now();

    // 提交长仿真，1 秒后调用方主动断开
    const abortedFetch = postJson(base, '/api/simulation', { ...LONG }, {
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 1000));
    controller.abort();
    await assert.rejects(abortedFetch, { name: 'AbortError' });

    // 关键断言：断开后立即提交一个很短的仿真。它需要同一个 worker；
    //   - 旧计算真的停下（worker 被 terminate 并补员）-> 几十毫秒内拿到；
    //   - 旧计算仍在跑 -> 必须等约一个完整长仿真（longSoloMs）。
    const followStart = Date.now();
    const followRes = await postJson(base, '/api/simulation', {
      lambda: 8,
      mu: 10,
      capacity: 4,
      seed: 1,
      maxArrivals: 50_000,
    });
    const followMs = Date.now() - followStart;
    assert.equal(followRes.status, 200);
    const followBody = await readJson(followRes);
    assert.equal(followBody.totalArrivals, 50_000);
    // 与该短输入在主线程单独运行的结果逐位一致
    assert.deepEqual(
      followBody,
      runSimulation({ lambda: 8, mu: 10, capacity: 4, seed: 1, maxArrivals: 50_000 }),
    );

    const elapsedSinceStart = Date.now() - startedAt;
    // 取消必须明显早于“把整段长仿真跑完”。给短任务与调度留出充足余量：
    // 阈值取 1.2s 连接期 + 单独长仿真耗时的一半，远小于完整长仿真。
    const threshold = 1200 + longSoloMs / 2;
    assert.ok(
      followMs < threshold,
      `断开后后续仿真等待 ${followMs}ms，阈值 ${Math.round(threshold)}ms；旧计算可能未被取消`,
    );
    assert.ok(
      elapsedSinceStart < longSoloMs,
      `总耗时 ${elapsedSinceStart}ms 不短于单独长仿真 ${longSoloMs}ms，取消未生效`,
    );

    // 断开之后紧跟的健康检查同样要及时
    const t0 = Date.now();
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.ok(Date.now() - t0 < HEALTH_BUDGET_MS);
  } finally {
    await stopServer(server, pool);
  }
});

test('3) 两个长对照并行：各自结果与单独运行逐位一致，短请求不排队', async () => {
  // 至少 2 个 worker 才能真并行
  const workerCount = Math.max(2, Math.min(os.availableParallelism(), 8));
  const { pool, server, base: baseUrl } = startServer(workerCount);
  const base = await baseUrl;

  try {
    const pairStart = Date.now();
    const pairPromises = PAIR_SEEDS.map((seed) =>
      postJson(base, '/api/simulation', {
        lambda: LONG.lambda,
        mu: LONG.mu,
        capacity: LONG.capacity,
        seed,
        maxTime: PAIR_MAX_TIME,
      }),
    );

    // 并行运行途中插入纯解析请求：不能跟在长仿真后面排队挨饿
    await new Promise((r) => setTimeout(r, 500));
    const analyticT0 = Date.now();
    const analyticRes = await postJson(base, '/api/analytic', {
      lambda: LONG.lambda,
      mu: LONG.mu,
      capacity: 4,
    });
    const analyticMs = Date.now() - analyticT0;
    assert.equal(analyticRes.status, 200);
    assert.ok(
      analyticMs < HEALTH_BUDGET_MS,
      `并行长仿真期间解析请求耗时 ${analyticMs}ms`,
    );

    const pairResponses = await Promise.all(pairPromises);
    const pairMs = Date.now() - pairStart;
    for (let i = 0; i < pairResponses.length; i += 1) {
      assert.equal(pairResponses[i].status, 200);
      const body = await readJson(pairResponses[i]);
      // 并发执行不改变任何一位结果，两个种子的随机数序列也各自独立
      assert.deepEqual(body, pairGolden[i].golden, `seed=${PAIR_SEEDS[i]} 并发结果不一致`);
      assert.equal(body.seed, PAIR_SEEDS[i]);
    }

    // 并行总耗时应明显少于两者单独耗时之和（同机 >=2 核时）
    if (os.availableParallelism() >= 2) {
      const serialSum = pairGolden.reduce((s, g) => s + g.soloMs, 0);
      assert.ok(
        pairMs < serialSum * 0.8,
        `并行 ${pairMs}ms 未明显短于串行之和 ${serialSum}ms（workers=${workerCount}）`,
      );
    }

    // 同一 worker 先后复用两次（强制串行）结果仍须与基准逐位一致：
    // 验证 worker 补员/复用不会把上一作业的随机数状态串给下一作业
    const repeat = await postJson(base, '/api/simulation', {
      lambda: 8,
      mu: 10,
      capacity: 4,
      seed: 20240901,
      maxArrivals: 50_000,
    });
    const repeatBody = await readJson(repeat);
    assert.deepEqual(
      repeatBody,
      runSimulation({ lambda: 8, mu: 10, capacity: 4, seed: 20240901, maxArrivals: 50_000 }),
    );
  } finally {
    await stopServer(server, pool);
  }
});
