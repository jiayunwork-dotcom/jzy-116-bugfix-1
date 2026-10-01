import type { SimulationInput, SimulationResult } from '../types.js';

/**
 * 主线程 → 仿真 worker 的消息。
 * 同一时刻一个 worker 只处理一个作业；cancel 只针对当前作业。
 */
export type WorkerRequest =
  | { id: number; type: 'start'; input: SimulationInput }
  | { id: number; type: 'cancel' }
  | { type: 'shutdown' };

/** 计算成功：返回逐字段的仿真结果 */
export interface WorkerSuccess {
  id: number;
  ok: true;
  result: SimulationResult;
}

/** 计算未能产出结果（输入非法 / 中途异常 / 被取消） */
export interface WorkerFailure {
  id: number;
  ok: false;
  /** 结构化错误类别，路由层据此选择 HTTP 状态码与错误语义 */
  errorKind: 'validation' | 'aborted' | 'internal';
  error: string;
}

export type WorkerResponse = WorkerSuccess | WorkerFailure;

/** 结构化错误：在 worker 边界把 Error 压成可跨线程传输的普通对象 */
export function serializeError(
  id: number,
  err: unknown,
  isValidation: boolean,
): WorkerFailure {
  const message = err instanceof Error ? err.message : String(err);
  return {
    id,
    ok: false,
    errorKind: isValidation ? 'validation' : 'internal',
    error: message,
  };
}

/** 判断一个异常是否为输入校验异常（按名字识别，避免跨 realm 的 instanceof） */
export function isValidationError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'ValidationError'
  );
}
