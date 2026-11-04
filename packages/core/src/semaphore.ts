/**
 * A first-in, first-out counting semaphore. Waiters are released in the order they queued, so
 * requests go out in the order checks asked for them.
 */
export class Semaphore {
  readonly #limit: number;
  #inFlight = 0;
  #maxInFlight = 0;
  readonly #queue: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError("Semaphore limit must be a positive integer.");
    this.#limit = limit;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  /** The highest number of holders seen at once. Tests read this to prove the cap. */
  get maxInFlight(): number {
    return this.#maxInFlight;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  acquire(): Promise<void> {
    if (this.#inFlight < this.#limit) {
      this.#take();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#queue.push(() => {
        this.#take();
        resolve();
      });
    });
  }

  release(): void {
    this.#inFlight -= 1;
    const next = this.#queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  #take(): void {
    this.#inFlight += 1;
    if (this.#inFlight > this.#maxInFlight) this.#maxInFlight = this.#inFlight;
  }
}
