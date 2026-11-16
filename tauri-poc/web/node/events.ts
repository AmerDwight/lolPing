// node:events for main-process code in a page.
type Listener = (...args: never[]) => void;

export class EventEmitter {
  static defaultMaxListeners = 10;
  private readonly listenerMap = new Map<string | symbol, Listener[]>();

  on(name: string | symbol, fn: Listener): this {
    this.listenerMap.set(name, [...(this.listenerMap.get(name) ?? []), fn]);
    return this;
  }

  addListener(name: string | symbol, fn: Listener): this {
    return this.on(name, fn);
  }

  prependListener(name: string | symbol, fn: Listener): this {
    this.listenerMap.set(name, [fn, ...(this.listenerMap.get(name) ?? [])]);
    return this;
  }

  once(name: string | symbol, fn: Listener): this {
    const once = (...args: never[]): void => {
      this.off(name, once);
      fn(...args);
    };
    (once as { listener?: Listener }).listener = fn;
    return this.on(name, once);
  }

  off(name: string | symbol, fn: Listener): this {
    const list = this.listenerMap.get(name) ?? [];
    const i = list.findIndex((l) => l === fn || (l as { listener?: Listener }).listener === fn);
    if (i >= 0) this.listenerMap.set(name, [...list.slice(0, i), ...list.slice(i + 1)]);
    return this;
  }

  removeListener(name: string | symbol, fn: Listener): this {
    return this.off(name, fn);
  }

  removeAllListeners(name?: string | symbol): this {
    if (name === undefined) this.listenerMap.clear();
    else this.listenerMap.delete(name);
    return this;
  }

  emit(name: string | symbol, ...args: unknown[]): boolean {
    const list = this.listenerMap.get(name) ?? [];
    // Node would throw an unheard 'error' and stop the process; the core page logs it and goes on.
    if (name === 'error' && list.length === 0) console.error('unhandled error event', args[0]);
    for (const fn of list) (fn as (...a: unknown[]) => void).apply(this, args);
    return list.length > 0;
  }

  listenerCount(name: string | symbol): number {
    return this.listenerMap.get(name)?.length ?? 0;
  }

  listeners(name: string | symbol): Listener[] {
    return [...(this.listenerMap.get(name) ?? [])];
  }

  eventNames(): (string | symbol)[] {
    return [...this.listenerMap.keys()].filter((k) => this.listenerCount(k) > 0);
  }

  setMaxListeners(_n: number): this {
    return this;
  }

  getMaxListeners(): number {
    return EventEmitter.defaultMaxListeners;
  }
}

export function once(emitter: EventEmitter, name: string): Promise<unknown[]> {
  return new Promise((resolve) => emitter.once(name, (...args: never[]) => resolve(args)));
}

export default EventEmitter;
