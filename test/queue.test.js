import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceQueue } from '../src/queue.js';

test('one job at a time; commands before polls, urgent ones first', async () => {
  const queue = new DeviceQueue();
  const order = [];
  let running = 0;
  const job = (name) => async () => {
    running += 1;
    assert.equal(running, 1, 'never two at once');
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(name);
    running -= 1;
    return name;
  };
  const all = [
    queue.run(job('poll 1'), 'poll'),
    queue.run(job('poll 2'), 'poll'),
    queue.run(job('volume'), 'command'),
    queue.run(job('standby'), 'urgent'),
    queue.run(job('poll 3'), 'poll'),
  ];
  assert.equal(queue.commandsWaiting, true);
  await Promise.all(all);
  assert.deepEqual(order, ['poll 1', 'standby', 'volume', 'poll 2', 'poll 3']);
});

test('a failing job does not stop the queue; close refuses what waits', async () => {
  const queue = new DeviceQueue();
  await assert.rejects(
    queue.run(async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await queue.run(async () => 'next'), 'next');
  // A write in flight is never cancelled.
  const slow = queue.run(
    () => new Promise((resolve) => setTimeout(() => resolve('done'), 20)),
    'command',
  );
  const waiting = queue.run(async () => 'never');
  queue.close();
  await assert.rejects(waiting, /stopped/);
  assert.equal(await slow, 'done');
  await assert.rejects(
    queue.run(async () => 1),
    /stopped/,
  );
});

test('preempt cancels a read in flight at once, even one ignoring its signal', async () => {
  const queue = new DeviceQueue();
  const started = Date.now();
  const read = queue.run(() => new Promise((resolve) => setTimeout(() => resolve('late'), 500)));
  const write = queue.run(async () => 'standby', 'urgent', { abortable: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  queue.preempt();
  await assert.rejects(read, (err) => err.code === 'aborted');
  assert.equal(await write, 'standby');
  assert.ok(Date.now() - started < 300);
  // A write is not abortable.
  const long = queue.run(
    () => new Promise((resolve) => setTimeout(() => resolve('written'), 30)),
    'command',
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  queue.preempt();
  assert.equal(await long, 'written');
});
