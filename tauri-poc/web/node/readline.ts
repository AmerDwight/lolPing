// node:readline's createInterface, for reading a child's output line by line.
import { EventEmitter } from './events';

interface Input {
  on(event: 'data', fn: (chunk: string | Uint8Array) => void): unknown;
  on(event: 'end', fn: () => void): unknown;
  off?(event: string, fn: (...a: never[]) => void): unknown;
}

export class Interface extends EventEmitter {
  private rest = '';
  private closed = false;
  private readonly decoder = new TextDecoder();

  constructor(private readonly input: Input) {
    super();
    input.on('data', this.onData);
    input.on('end', this.onEnd);
  }

  private readonly onData = (chunk: string | Uint8Array): void => {
    if (this.closed) return;
    this.rest += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.rest.indexOf('\n')) >= 0) {
      const line = this.rest.slice(0, nl).replace(/\r$/, '');
      this.rest = this.rest.slice(nl + 1);
      this.emit('line', line);
      if (this.closed) return;
    }
  };

  private readonly onEnd = (): void => {
    if (this.rest) this.emit('line', this.rest.replace(/\r$/, ''));
    this.rest = '';
    this.close();
  };

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.off?.('data', this.onData as never);
    this.input.off?.('end', this.onEnd as never);
    this.emit('close');
  }
}

export const createInterface = (o: { input: Input; crlfDelay?: number }): Interface => new Interface(o.input);

export default { createInterface, Interface };
