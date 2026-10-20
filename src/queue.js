// -----------------------------------------------------------------------------
// The request queue of one device: one request at a time, so a device never
// sees two requests of Gladys at once. Every job is ONE request (a poll, a
// list read or a volume check is a series of jobs), so a command waits at
// most for the one request in flight. Commands go before the reads still
// waiting; an urgent command (standby, mute) goes before the other commands.
//
// A read job is `abortable`: it gets an AbortSignal, and `preempt()` (called
// by every command) cancels it and moves on at once, even when the request
// ignores the signal, so Standby never waits behind a slow read. A command
// job (a write) is never aborted.
// -----------------------------------------------------------------------------

const RANK = { urgent: 0, command: 1, poll: 2 };

export class DeviceQueue {
  constructor() {
    this.items = [];
    this.running = undefined;
    this.closed = false;
  }

  /**
   * Run `task(signal)` when its turn comes; `lane` is 'urgent', 'command' or
   * 'poll'. A read is abortable by default in the poll lane.
   */
  run(task, lane = 'poll', { abortable = lane === 'poll' } = {}) {
    if (this.closed) {
      return Promise.reject(new Error('stopped'));
    }
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, rank: RANK[lane] ?? RANK.poll, abortable };
      const index = this.items.findIndex((other) => other.rank > item.rank);
      this.items.splice(index === -1 ? this.items.length : index, 0, item);
      this.drain();
    });
  }

  /** Commands waiting (a poll in progress gives way to them). */
  get commandsWaiting() {
    return this.items.some((item) => item.rank < RANK.poll);
  }

  /** Cancel the job in flight when it is an abortable read. */
  preempt() {
    if (this.running?.abortable) {
      this.running.controller.abort();
    }
  }

  async drain() {
    if (this.running) {
      return;
    }
    while (this.items.length > 0) {
      const item = this.items.shift();
      item.controller = new AbortController();
      this.running = item;
      const { signal } = item.controller;
      // The queue moves on at the abort even if the task ignores its signal.
      const aborted = new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('cancelled'), { code: 'aborted' })),
          { once: true },
        );
      });
      aborted.catch(() => {}); // an abort after the end is nobody's error
      try {
        item.resolve(
          await Promise.race([Promise.resolve().then(() => item.task(signal)), aborted]),
        );
      } catch (err) {
        item.reject(err);
      }
    }
    this.running = undefined;
  }

  /** Refuse what still waits, cancel a read in flight; a write ends by itself. */
  close() {
    this.closed = true;
    this.preempt();
    for (const item of this.items.splice(0)) {
      item.reject(new Error('stopped'));
    }
  }
}
