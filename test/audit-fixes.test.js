import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hexToBytes } from '../src/crypto/encoding.js';
import { parseVox, MAX_SUPPLY } from '../src/chain/params.js';
import { FileStorage, startServer } from '../src/node/server.js';
import { MemoryStorage } from '../src/chain/blockchain.js';
import { createServices } from '../src/api/services.js';

test('hex is lowercase only, so one signature has one encoding', () => {
  assert.throws(() => hexToBytes('AB'), /invalid hex/);
  assert.deepEqual([...hexToBytes('ab')], [0xab]);
});

test('parseVox refuses amounts above the max supply', () => {
  assert.equal(parseVox('210000000'), MAX_SUPPLY);
  assert.throws(() => parseVox('210000001'), /max supply/);
  assert.throws(() => parseVox('999999999'), /max supply/);
});

test('oracle rejects inherited object keys instead of returning null prices', () => {
  const services = createServices({ height: 0 });
  const oracle = services.find((s) => s.id === 'oracle-price');
  assert.ok(oracle, 'oracle service present');
  for (const pair of ['constructor', 'toString', '__proto__']) {
    assert.throws(() => oracle.handler({ query: { pair } }), /unknown pair/);
  }
});

test('a torn trailing record is dropped so the next block is not glued onto it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxian-log-'));
  const storage = new FileStorage(dir).bind('abcdef123456');
  fs.writeFileSync(storage.file, '{"height":0}\n{"height":1}\n{"heig');
  const blocks = await storage.load();
  assert.deepEqual(blocks.map((b) => b.height), [0, 1]);
  assert.equal(fs.readFileSync(storage.file, 'utf8'), '{"height":0}\n{"height":1}\n');
  await storage.append({ height: 2 });
  assert.deepEqual((await storage.load()).map((b) => b.height), [0, 1, 2]);
});

test('the public devnet secret cannot be used on a public interface', async () => {
  await assert.rejects(
    startServer({ port: 0, host: '0.0.0.0', storage: new MemoryStorage(), quiet: true }),
    /public devnet secret/,
  );
});
