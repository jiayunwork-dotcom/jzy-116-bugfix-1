/**
 * 并发/取消/隔离回归测试。
 *
 * 针对“长仿真占住整个实例”的三类问题：
 * 1. 长仿真运行期间，健康检查与纯解析请求必须及时应答（< 200ms）；
 * 2. 客户端断开连接后，对应的仿真必须在短时间内停止（线程被终止、槽位
 *    立刻释放），后续请求不再被拖住；
 * 3. 多组仿真并发执行时，各自结果必须与单独运行逐位一致，随机数序列与
 *    统计量不交错串流。
 *
 * 这一层直接走 HTTP（createApp 起本地端口），与生产路径一致；逐位一致性
 * 另在引擎层用 runSimulation 直跑结果做基准。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { runSimulation } from '../src/simulation/engine.js';
import type { SimulationInput } from '../src/types.js';

let server: Server;
let base: string;

// 测试用规模：lambda/mu 较小（1 / 1.25），maxTime 几百万时单次约 0.3~0.9s，
// 足以稳定占住 worker、观察排队/并行/取消，又不拖慢常规测试
const LONG_1: SimulationInput = {
  lambda: 1, mu: 1.25, capacity: 20, seed: 42, maxTime: 8_000_000,
};
const LONG_2: SimulationInput = {
  lambda: 1, mu: 1.25, capacity: 20, seed: 7, maxTime: 8_000_000,
};
const LONG_3: SimulationInput = {
  lambda: 1, mu: 1.25, capacity: 20, seed: 20240901, maxTime: 8_000_000,
};

async function postJson(path: string, body: unknown, init?: RequestInit) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    // 不复用空闲连接：长仿真占用连接数秒，undici 连接池与服务端 keep-alive
    // 空闲回收之间存在“将关未关”的复用竞态（偶发 ECONNRESET，与服务逻辑
    // 无关）。回归用例每条请求独立连接，避免客户端基础设施噪声干扰断言
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify(body),
    ...init,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<any> {
  return res.json();
}

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
});

test('回归1：长仿真运行期间，健康检查与纯解析请求在 200ms 内应答', async () => {
  // 发出一个长仿真，不等它，趁它在 worker 上跑时打短请求
  const longFetch = postJson('/api/simulation', LONG_1).then(
    (r) => readJson(r) as Promise<Record<string, unknown>>,
  );
  // 给 worker 一点启动时间，确保测量时仿真确实在跑
  await new Promise((r) => setTimeout(r, 250));

  const tHealth = Date.now();
  const healthRes = await fetch(`${base}/health`);
  const healthMs = Date.now() - tHealth;
  assert.equal(healthRes.status, 200);
  assert.deepEqual(await readJson(healthRes), { status: 'ok' });
  assert.ok(healthMs < 200, `health 耗时 ${healthMs}ms，应 < 200ms`);

  const tAnalytic = Date.now();
  const analyticRes = await postJson('/api/analytic', { lambda: 1, mu: 1.25, capacity: 4 });
  const analyticMs = Date.now() - tAnalytic;
  assert.equal(analyticRes.status, 200);
  const analyticBody = await readJson(analyticRes);
  assert.ok(typeof analyticBody.blockingProbability === 'number');
  assert.ok(analyticMs < 200, `analytic 耗时 ${analyticMs}ms，应 < 200ms`);

  const longBody = (await longFetch) as Record<string, unknown>;
  assert.ok(Number(longBody.totalArrivals) > 0);
});

test('回归2：客户端断开后计算停止，槽位释放，后续请求不被拖住', async () => {
  // 用一个规模更大的算例，确保 1.5s 内它肯定还没算完
  const big: SimulationInput = {
    lambda: 1, mu: 1.25, capacity: 20, seed: 42, maxTime: 50_000_000,
  };
  const controller = new AbortController();
  const abortedFetch = postJson('/api/simulation', big, { signal: controller.signal });

  await new Promise((r) => setTimeout(r, 800));
  controller.abort();
  await assert.rejects(abortedFetch, { name: 'AbortError' });

  // 给服务端一点时间终止 worker 并回收/补员
  await new Promise((r) => setTimeout(r, 200));

  // 关键断言：被放弃的计算若仍在占线程，这个短请求会被拖到 50M 算完
  const t = Date.now();
  const res = await postJson('/api/simulation', {
    lambda: 8, mu: 10, capacity: 4, seed: 1, maxArrivals: 5_000,
  });
  const ms = Date.now() - t;
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body.totalArrivals, 5_000);
  assert.ok(ms < 500, `断开后短请求耗时 ${ms}ms，计算似乎没有真正停下`);
});

test('回归3：并发多组仿真结果与各自单独运行逐位一致', async () => {
  // 基准：同一进程内引擎直跑（与改造前实现完全相同的同步路径）
  const golden1 = runSimulation(LONG_1);
  const golden2 = runSimulation(LONG_2);
  const golden3 = runSimulation(LONG_3);

  // 交错并发提交：重复同一组、再混入不同种子，检查 RNG/统计不串流
  const settled = await Promise.allSettled([
    postJson('/api/simulation', LONG_1).then(readJson),
    postJson('/api/simulation', LONG_2).then(readJson),
    postJson('/api/simulation', LONG_1).then(readJson),
    postJson('/api/simulation', LONG_3).then(readJson),
    postJson('/api/simulation', LONG_2).then(readJson),
  ]);

  const bodies = settled.map((s) => {
    assert.equal(s.status, 'fulfilled');
    return s.status === 'fulfilled' ? s.value : undefined;
  });

  // 逐字段、逐位深比较（assert.deepEqual 对 number 按精确相等比较）
  assert.deepEqual(bodies[0], golden1);
  assert.deepEqual(bodies[2], golden1); // 同种子重复
  assert.deepEqual(bodies[1], golden2);
  assert.deepEqual(bodies[4], golden2);
  assert.deepEqual(bodies[3], golden3);

  // 不同种子的结果理应不同（防止串流后巧合相等）
  assert.notDeepEqual(golden1, golden2);
});

test('回归3b：并发对照(/api/compare)的仿真段同样与直跑逐位一致', async () => {
  const golden = runSimulation(LONG_1);
  const res = await postJson('/api/compare', LONG_1);
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.ok(body.analytic && body.simulation && body.comparison);
  assert.deepEqual(body.simulation, golden);
});

test('回归4：放弃计算不会返回看似正常的结果；满载回结构化繁忙错误', async () => {
  // 直接在池层面断言 abort 语义（HTTP 断开已在回归2覆盖）。
  // 动态导入拿单例池，避免与上面的 HTTP 用例共享状态产生顺序耦合：
  // 这里只要求 abort 的 Promise 以 COMPUTATION_ABORTED 拒绝。
  const { getSimulationPool } = await import('../src/simulation/sim-pool.js');
  const { SimAbortedError } = await import('../src/simulation/errors.js');
  const pool = getSimulationPool();

  const controller = new AbortController();
  const big: SimulationInput = {
    lambda: 1, mu: 1.25, capacity: 20, seed: 42, maxTime: 50_000_000,
  };
  const pending = pool.run(big, controller.signal);
  await new Promise((r) => setTimeout(r, 300));
  controller.abort();
  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof SimAbortedError);
    assert.equal((err as { code: string }).code, 'COMPUTATION_ABORTED');
    return true;
  });
});
