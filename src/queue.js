// -----------------------------------------------------------------------------
// The request queue of one device: one request at a time, so a device never
// sees two requests of Gladys at once. Commands go before the poll requests
// still waiting (a poll is a series of short jobs, so a command waits at most
// for the one request in flight); an urgent command (standby, mute) goes
// before the other commands waiting.
// -----------------------------------------------------------------------------

const RANK = { urgent: 0, command: 1, poll: 2 };

export class DeviceQueue {
  constructor() {
    this.items = [];
    this.running = false;
    this.closed = false;
  }

  /** Run `task` when its turn comes; `lane` is 'urgent', 'command' or 'poll'. */
  run(task, lane = 'poll') {
    if (this.closed) {
      return Promise.reject(new Error('stopped'));
    }
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, rank: RANK[lane] ?? RANK.poll };
      const index = this.items.findIndex((other) => other.rank > item.rank);
      this.items.splice(index === -1 ? this.items.length : index, 0, item);
      this.drain();
    });
  }

  /** Commands waiting (a poll in progress gives way to them). */
  get commandsWaiting() {
    return this.items.some((item) => item.rank < RANK.poll);
  }

  async drain() {
    if (this.running) {
      return;
    }
    this.running = true;
    while (this.items.length > 0) {
      const item = this.items.shift();
      try {
        item.resolve(await item.task());
      } catch (err) {
        item.reject(err);
      }
    }
    this.running = false;
  }

  /** Refuse what still waits; the request in flight ends by itself. */
  close() {
    this.closed = true;
    for (const item of this.items.splice(0)) {
      item.reject(new Error('stopped'));
    }
  }
}
