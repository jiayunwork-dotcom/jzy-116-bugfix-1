# M/M/1/K 排队核算服务

有限容量单服务台排队（M/M/1/K）的容量评估后端：对同一组到达率 λ、服务率 μ、
系统总容量 K（含正在服务的那一个），同时给出**稳态解析值**与**离散事件仿真值**，
并把阻塞概率、平均队长、利用率三样指标摆到一起互相印证。

## 统一的模型语义

解析与仿真共用同一套状态定义与拒绝语义，不存在“一边按排队人数、一边按缓冲槽位”的错位：

- 系统状态 `n = 系统内顾客数`，取值 `0..K`，**n 已包含正在被服务的顾客**；
- `n === K` 时新到达的请求**立即拒绝（阻塞/丢弃）**，不排队、不改变到达过程；
- 到达间隔 `Exp(λ)`，服务时间 `Exp(μ)`，单服务台。

## 解析模型

生灭过程细致平衡给出几何级数形式的稳态分布：

```
π_n = π_0 · ρ^n,   ρ = λ/μ,   n = 0..K
```

- `ρ = 1` 时退化为均匀分布 `π_n = 1/(K+1)`；
- 阻塞概率 `P_block = π_K`；
- 有效到达率 `λ_e = λ(1 - π_K)`；
- 利用率 `U = λ_e / μ = 1 - π_0`；
- 平均队长 `L = Σ n·π_n`；
- 平均逗留时间 `W = L / λ_e`（`λ_e = 0` 的极端情形定义为 0，不返回无穷）。

几何权重在对数空间计算并平移，ρ > 1、K 较大时也不会上溢成 NaN。

## 仿真模型

- 事件表（最小堆）推进仿真时钟，只含 `arrival` / `departure` 两类事件；
- PRNG 固定为 **mulberry32**（算法名随响应返回 `rngAlgorithm`），
  指数样本由逆变换 `-ln(U)/rate` 得到；**同一 seed 两次运行结果逐位一致**；
- 停止条件 `maxArrivals`（到达尝试数，含被拒）与 `maxTime`（仿真时长）至少给一个，先到先停；
- 平均队长、利用率均为时间加权平均（状态对时间积分 / 时域长度）；
  经验阻塞比例 = 被拒到达数 / 总到达尝试数。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/analytic` | 只算稳态解析 |
| `POST` | `/api/simulation` | 只跑离散事件仿真 |
| `POST` | `/api/compare` | 一次返回两者及三样指标对照表 |
| `GET` | `/health` | 健康检查 |

`/api/analytic` 请求体：

```json
{ "lambda": 8, "mu": 10, "capacity": 4 }
```

`/api/simulation` 与 `/api/compare` 额外需要仿真控制参数：

```json
{
  "lambda": 8, "mu": 10, "capacity": 4,
  "seed": 20240901,
  "maxArrivals": 500000,
  "maxTime": 400
}
```

校验规则：`lambda`、`mu` 必须为正数，`capacity` 必须为正整数，
`seed` 为 `[0, 2^32-1]` 内整数（缺省 1），停止条件至少提供一个。
非法输入返回 `400` 与错误信息。

`/api/compare` 的 `comparison` 字段逐项给出 `analytic`、`simulation`、`absoluteDifference`。

## 本地运行（Node.js 20）

```bash
npm ci
npm run build
npm start                 # 默认 8080，可用 PORT 覆盖
npm test                  # node:test 自动化测试（解析/仿真/接口）
npm run typecheck
```

开发模式：`npm run dev`（tsx watch）。

## Docker

```bash
docker build -t mm1k-capacity-service .
docker run --rm -p 8080:8080 mm1k-capacity-service
```

基于 `node:20-slim`，镜像内完成 TypeScript 编译并裁剪掉开发依赖，单容器启动后即对外应答。

## 模块划分

```
src/
  types.ts                    共享类型与模型语义约定
  analytics/analytic.ts       稳态分布与解析指标
  simulation/
    rng.ts                    mulberry32 随机数发生器 + 指数抽样
    event-list.ts             最小堆事件表
    engine.ts                 离散事件仿真引擎
  metrics/metrics.ts          时间加权累加器与对照表汇总
  validation/validation.ts    输入校验（解析/仿真/路由共用）
  routes/queue-routes.ts      三个业务接口
  app.ts / server.ts          Express 装配与启动
test/                         解析、仿真、HTTP 三层自动化测试
```

## 关键回归测试

- 长仿真 + 固定种子：经验阻塞比例/利用率/平均队长落入解析值容差；
- 阻塞概率关于 K 单调不增（ρ<1、=1、>1 三种情形）；
- λ、μ 同比例放大（比值不变）：稳态分布形状不变；
- 预置算例 λ=0.8、μ=1（ρ=0.8）、K=200：平均队长收敛到无限容量
  经典闭式 `L = ρ/(1-ρ) = 4`、`W = 1/(μ-λ) = 5`。
