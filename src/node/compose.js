// Wires a full Voxian node (chain + consensus + x402 facilitator + paid services + API) independent of transport.
import { Blockchain, devnetKeys, MemoryStorage } from '../chain/blockchain.js';
import { Consensus, HttpTransport } from '../chain/consensus.js';
import { DEFAULT_DEVNET_SECRET, accountKeyFromSeed } from '../chain/keys.js';
import { hexToBytes } from '../crypto/encoding.js';
import { deriveShieldedKeys } from '../zk/shielded.js';
import { Facilitator } from '../x402/facilitator.js';
import { createServices } from '../api/services.js';
import { createRouter } from '../api/router.js';

// A validator key from a 32-byte hex seed (Phase 4: validators registered on-chain with their own keys).
export function validatorFromSeed(seedHex, name) {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error('validator seed must be 64 hex chars');
  const k = accountKeyFromSeed(hexToBytes(seedHex));
  return { name: name || `validator-${k.address.slice(4, 12)}`, ...k };
}

// validators: 'all' (standalone devnet), 'none' (observer/RPC node), or a list of names such as ['aurora'].
export function selectValidators(keys, validators = 'all') {
  if (validators === 'all') return keys.validators.slice();
  if (validators === 'none' || !validators) return [];
  const names = (Array.isArray(validators) ? validators : String(validators).split(',')).map((s) => s.trim()).filter(Boolean);
  return names.map((n) => {
    const v = keys.validators.find((x) => x.name === n || x.name === `vox-validator-${n}`);
    if (!v) throw new Error(`unknown validator "${n}" (known: ${keys.validators.map((x) => x.name.replace('vox-validator-', '')).join(', ')})`);
    return v;
  });
}

export function createNode({ storage = new MemoryStorage(), secret = DEFAULT_DEVNET_SECRET, validators = 'all', validatorSeed, peers = [], selfUrl = null, transport, now, operatorToken, log = () => {} } = {}) {
  const keys = devnetKeys(secret);
  const chain = new Blockchain({ keys, storage, now });
  const net = transport ?? (peers.length ? new HttpTransport(peers, { self: selfUrl }) : null);
  const localValidators = selectValidators(keys, validators);
  if (validatorSeed) localValidators.push(validatorFromSeed(validatorSeed));
  const consensus = new Consensus({ chain, localValidators, transport: net, storage, log });
  const facilitator = new Facilitator(chain, keys.facilitator);
  const services = createServices(chain);
  const shielded = deriveShieldedKeys(keys.serviceSeed);
  const payee = { address: keys.service.address, zaddress: shielded.zaddress, shielded };
  const handle = createRouter({ chain, consensus, facilitator, services, payee, keys, operatorToken });
  return {
    chain, consensus, facilitator, services, payee, keys, handle,
    init: () => chain.init(),
    start: () => consensus.start(),
    stop: () => consensus.stop(),
  };
}
