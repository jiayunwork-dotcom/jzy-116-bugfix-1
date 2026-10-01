// 构建后处理：tsc 只编译 .ts，不会把 src/simulation/worker-bootstrap.mjs
// 输出到 dist/。这个引导文件是仿真工作线程的入口（生产环境直接 import 编译
// 出来的 simulation-worker.js），因此构建时需要原样拷贝到对应的 dist 目录。
// 用 node 脚本而不是 cp -r，保证在非 POSIX 环境下也能执行。
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const from = `${root}src/simulation/worker-bootstrap.mjs`;
const to = `${root}dist/simulation/worker-bootstrap.mjs`;

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`已拷贝仿真 worker 引导：${from} -> ${to}`);
