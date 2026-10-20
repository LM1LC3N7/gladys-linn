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
  const slow = queue.run(() => new Promise((resolve) => setTimeout(() => resolve('done'), 20)));
  const waiting = queue.run(async () => 'never');
  queue.close();
  await assert.rejects(waiting, /stopped/);
  assert.equal(await slow, 'done');
  await assert.rejects(
    queue.run(async () => 1),
    /stopped/,
  );
});
