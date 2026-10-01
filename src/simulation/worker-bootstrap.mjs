// 仿真工作线程引导（纯 JavaScript，刻意不用 TypeScript / tsx 语法）。
//
// 为什么需要它：worker_threads 默认不会继承主线程通过 `--import tsx` 装的
// ESM 加载钩子，直接用 TS 文件 URL 起 worker 会报 ERR_UNKNOWN_FILE_EXTENSION。
// 这个文件本身是合法的普通 ESM，任何环境下默认加载器都能直接执行，再由它
// 按“编译产物是否存在”选择真正的 worker 入口：
//
//   - 生产镜像（dist/）：simulation-worker.js 已由 tsc 编译产出，直接动态
//     import，全程不碰 tsx（tsx 已在镜像构建阶段被 npm prune 裁掉）；
//   - 开发 / 自动化测试（node --import tsx 直接跑 src/*.ts）：没有 .js 产物，
//     此时通过 tsx 的编程式 ESM API（tsx/esm/api 的 register）在本 worker 内
//     装上 TS 加载钩子，再 import simulation-worker.ts。
//
// 两条路最终执行的是同一份仿真引擎逻辑，结果没有差别。
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const jsEntry = path.join(here, 'simulation-worker.js');
const tsEntry = path.join(here, 'simulation-worker.ts');

if (existsSync(jsEntry)) {
  // 生产：编译后的普通 ESM，默认加载器直接可跑
  await import(pathToFileURL(jsEntry).href);
} else {
  // 开发 / 测试：用编程方式注册 tsx（等价于给这个 worker 单独加 --import tsx）。
  // 此时 tsx 尚未注册，import.meta.resolve 走默认加载器并按 "import" 条件解析，
  // 命中 tsx 的 ESM 入口（.mjs）；不能用 require.resolve，那会命中 CJS 入口。
  // parentURL 显式指向本文件，保证从本目录向上的 node_modules 能找到 tsx。
  const tsxApi = await import.meta.resolve('tsx/esm/api', import.meta.url);
  const tsx = await import(tsxApi);
  tsx.register();
  await import(pathToFileURL(tsEntry).href);
}
