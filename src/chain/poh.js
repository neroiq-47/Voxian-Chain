// Proof of History: a sequential SHA-256 chain that proves time passed between two points and fixes the
// order of everything mixed into it. Producing N hashes takes N sequential steps; anyone can verify by
// recomputing them. Entries are compact:
//   { t: k, h }  – k ticks (k * HASHES_PER_TICK hashes) ending at hash h
//   { m: x, h }  – mix-in of tx hash x:  h = H("Voxian/poh-mix", prev, x)
import { hexToBytes, bytesToHex, utf8 } from '../crypto/encoding.js';
import { taggedHash, taggedHasher32, sha256Hex } from '../crypto/sha256.js';
import { HASHES_PER_TICK } from './params.js';

const HEX64 = /^[0-9a-f]{64}$/;
export const pohSeed = (genesisHash) => sha256Hex(`Voxian/poh-genesis:${genesisHash}`);

const pohStep = taggedHasher32('Voxian/poh'); // == taggedHash('Voxian/poh', h), one compression per hash
const hashTicks = (h, ticks) => (ticks > 0 ? pohStep(h, ticks * HASHES_PER_TICK) : h);
const mix = (h, x) => taggedHash('Voxian/poh-mix', h, utf8(x));

export class PohRecorder {
  constructor(startHex) { this.reset(startHex); }

  reset(startHex) {
    this.start = startHex;
    this.hash = hexToBytes(startHex);
    this.entries = [];
    this.ticks = 0;
  }

  tick(n = 1) {
    this.hash = hashTicks(this.hash, n);
    this.ticks += n;
    const last = this.entries[this.entries.length - 1];
    const h = bytesToHex(this.hash);
    if (last && last.t !== undefined) { last.t += n; last.h = h; } else this.entries.push({ t: n, h });
  }

  get end() { return bytesToHex(this.hash); }

  // PoH segment for a block: the ticks recorded so far, then the block's tx hashes mixed in order.
  // The live recorder is not modified (if the proposal fails, the next leader continues from the tip).
  segment(txHashes) {
    let h = this.hash;
    const entries = this.entries.map((e) => ({ ...e }));
    for (const x of txHashes) { h = mix(h, x); entries.push({ m: x, h: bytesToHex(h) }); }
    return { ticks: this.ticks, end: bytesToHex(h), entries };
  }
}

// Recompute a segment. Returns { end, ticks, mixins } or throws. maxTicks bounds verification work.
export function verifyPoh(startHex, entries, { maxTicks = Infinity, maxEntries = 10_000 } = {}) {
  if (!Array.isArray(entries) || entries.length > maxEntries) throw new Error('bad PoH entries');
  let h = hexToBytes(startHex);
  let ticks = 0;
  const mixins = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object' || typeof e.h !== 'string' || !HEX64.test(e.h)) throw new Error('bad PoH entry');
    if (e.t !== undefined) {
      if (Object.keys(e).length !== 2 || !Number.isSafeInteger(e.t) || e.t < 1) throw new Error('bad PoH tick entry');
      ticks += e.t;
      if (ticks > maxTicks) throw new Error('PoH segment too long');
      h = hashTicks(h, e.t);
    } else if (e.m !== undefined) {
      if (Object.keys(e).length !== 2 || typeof e.m !== 'string' || !HEX64.test(e.m)) throw new Error('bad PoH mix entry');
      h = mix(h, e.m);
      mixins.push(e.m);
    } else throw new Error('bad PoH entry');
    if (bytesToHex(h) !== e.h) throw new Error('PoH hash mismatch');
  }
  return { end: bytesToHex(h), ticks, mixins };
}
