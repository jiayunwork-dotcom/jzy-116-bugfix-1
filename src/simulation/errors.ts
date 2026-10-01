import type { SimulationInput, SimulationResult } from '../types.js';

/**
 * 仿真执行阶段的错误基类。
 *
 * 输入校验错误（400）仍由 validation 层负责；这里只覆盖“请求合法、但执行
 * 环节出状况”的三类情形，每一类都带稳定的机器可读 code 与 HTTP 状态码，
 * 路由层统一转成结构化 JSON，绝不静默吞掉、也绝不伪装成正常结果。
 */
export class SimExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 并发槽位与等待队列都满了：服务繁忙，调用方可稍后重试（503） */
export class SimBusyError extends SimExecutionError {
  constructor(message = '仿真服务繁忙：并发槽位与等待队列均已满，请稍后重试') {
    super('SIMULATION_BUSY', 503, message);
  }
}

/** 调用方放弃等待（如断开连接），计算已被终止，不返回任何结果（499） */
export class SimAbortedError extends SimExecutionError {
  constructor(message = '计算已被调用方放弃') {
    super('COMPUTATION_ABORTED', 499, message);
  }
}

/** 计算已经开始后在执行单元内部失败：结构化 500，进程不受影响 */
export class SimFailedError extends SimExecutionError {
  constructor(message: string) {
    super('SIMULATION_FAILED', 500, `仿真执行失败：${message}`);
  }
}

/** 线程池里一个待执行的仿真作业 */
export interface SimJob {
  id: number;
  input: SimulationInput;
  resolve: (result: SimulationResult) => void;
  reject: (error: unknown) => void;
}
