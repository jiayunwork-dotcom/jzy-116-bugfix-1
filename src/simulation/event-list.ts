/**
 * 离散事件仿真用的事件表：按发生时刻弹出最早事件。
 * 同时刻事件按插入先后（seq）执行，保证结果确定、与种子一一对应。
 */
export type EventKind = 'arrival' | 'departure';

export interface SimEvent {
  kind: EventKind;
  time: number;
  /** 插入序号，同时间时作为平局裁决 */
  seq: number;
}

export class EventList {
  private heap: SimEvent[] = [];
  private counter = 0;

  get size(): number {
    return this.heap.length;
  }

  push(kind: EventKind, time: number): void {
    const event: SimEvent = { kind, time, seq: this.counter++ };
    this.heap.push(event);
    this.siftUp(this.heap.length - 1);
  }

  pop(): SimEvent | undefined {
    const heap = this.heap;
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop() as SimEvent;
    if (heap.length > 0) {
      heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private static less(a: SimEvent, b: SimEvent): boolean {
    if (a.time !== b.time) return a.time < b.time;
    return a.seq < b.seq;
  }

  private siftUp(index: number): void {
    const heap = this.heap;
    const event = heap[index];
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!EventList.less(event, heap[parent])) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = event;
  }

  private siftDown(index: number): void {
    const heap = this.heap;
    const n = heap.length;
    const event = heap[index];
    while (true) {
      const left = 2 * index + 1;
      const right = left + 1;
      let smallest = index;
      if (left < n && EventList.less(heap[left], heap[smallest])) smallest = left;
      if (right < n && EventList.less(heap[right], heap[smallest])) smallest = right;
      if (smallest === index) break;
      heap[index] = heap[smallest];
      index = smallest;
    }
    heap[index] = event;
  }
}
