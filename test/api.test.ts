import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';

let server: Server;
let base: string;

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

async function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Node 20 的 fetch 类型把响应体标成 unknown，测试里按宽松结构读取
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<any> {
  return res.json();
}

test('GET /health', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await readJson(res), { status: 'ok' });
});

test('POST /api/analytic 返回稳态结果', async () => {
  const res = await post('/api/analytic', { lambda: 8, mu: 10, capacity: 4 });
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body.stateProbabilities.length, 5);
  assert.ok(Math.abs(body.rho - 0.8) < 1e-12);
  assert.ok(body.blockingProbability >= 0 && body.blockingProbability <= 1);
  assert.ok(
    Math.abs(body.utilization - (1 - body.stateProbabilities[0])) < 1e-12,
  );
});

test('POST /api/simulation 返回经验指标且同种子可复现', async () => {
  const payload = {
    lambda: 8,
    mu: 10,
    capacity: 4,
    seed: 20240901,
    maxArrivals: 50_000,
  };
  const [r1, r2] = await Promise.all([post('/api/simulation', payload), post('/api/simulation', payload)]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const b1 = await readJson(r1);
  const b2 = await readJson(r2);
  assert.deepEqual(b1, b2);
  assert.equal(b1.rngAlgorithm, 'mulberry32');
  assert.equal(b1.accepted + b1.rejected, b1.totalArrivals);
});

test('POST /api/compare 一次给出两边对照表', async () => {
  const payload = {
    lambda: 8,
    mu: 10,
    capacity: 4,
    seed: 20240901,
    maxArrivals: 200_000,
  };
  const res = await post('/api/compare', payload);
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.ok(body.analytic && body.simulation && body.comparison);
  for (const key of [
    'blockingProbability',
    'meanNumberInSystem',
    'utilization',
  ] as const) {
    const c = body.comparison[key];
    assert.ok(
      Math.abs(
        c.absoluteDifference -
          Math.abs(c.analytic - c.simulation),
      ) < 1e-12,
    );
  }
  // 样本量足够时两边应一致
  assert.ok(body.comparison.blockingProbability.absoluteDifference < 0.02);
  assert.ok(body.comparison.utilization.absoluteDifference < 0.02);
});

test('非法输入返回 400 错误响应', async () => {
  const bad = [
    { lambda: -1, mu: 10, capacity: 4 },
    { lambda: 8, mu: 0, capacity: 4 },
    { lambda: 8, mu: 10, capacity: 2.5 },
    { lambda: 8, mu: 10, capacity: 4, seed: 1 }, // 缺停止条件
    { lambda: 8, mu: 10, capacity: 0, seed: 1, maxArrivals: 10 },
  ];
  for (const payload of bad) {
    const res = await post('/api/simulation', payload);
    assert.equal(res.status, 400, JSON.stringify(payload));
    const body = await readJson(res);
    assert.equal(typeof body.error, 'string');
  }
});

test('非法 JSON 与未知路由分别返回 400 / 404', async () => {
  const res = await fetch(`${base}/api/analytic`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);

  const res404 = await fetch(`${base}/nope`);
  assert.equal(res404.status, 404);
});
