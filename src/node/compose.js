// Wires a full Voxian node (chain + consensus + x402 facilitator + paid services + API) independent of transport.
import { Blockchain, devnetKeys, MemoryStorage } from '../chain/blockchain.js';
import { Consensus, HttpTransport } from '../chain/consensus.js';
import { DEFAULT_DEVNET_SECRET } from '../chain/keys.js';
import { deriveShieldedKeys } from '../zk/shielded.js';
import { Facilitator } from '../x402/facilitator.js';
import { createServices } from '../api/services.js';
import { createRouter } from '../api/router.js';

// validators: 'all' (standalone devnet), 'none' (observer/RPC node), or a list of names such as ['aurora'].
export function selectValidators(keys, validators = 'all') {
  if (validators === 'all') return keys.validators;
  if (validators === 'none' || !validators) return [];
  const names = (Array.isArray(validators) ? validators : String(validators).split(',')).map((s) => s.trim()).filter(Boolean);
  return names.map((n) => {
    const v = keys.validators.find((x) => x.name === n || x.name === `vox-validator-${n}`);
    if (!v) throw new Error(`unknown validator "${n}" (known: ${keys.validators.map((x) => x.name.replace('vox-validator-', '')).join(', ')})`);
    return v;
  });
}

export function createNode({ storage = new MemoryStorage(), secret = DEFAULT_DEVNET_SECRET, validators = 'all', peers = [], transport, now, log = () => {} } = {}) {
  const keys = devnetKeys(secret);
  const chain = new Blockchain({ keys, storage, now });
  const net = transport ?? (peers.length ? new HttpTransport(peers) : null);
  const consensus = new Consensus({ chain, localValidators: selectValidators(keys, validators), transport: net, log });
  const facilitator = new Facilitator(chain, keys.facilitator);
  const services = createServices(chain);
  const shielded = deriveShieldedKeys(keys.serviceSeed);
  const payee = { address: keys.service.address, zaddress: shielded.zaddress, shielded };
  const handle = createRouter({ chain, consensus, facilitator, services, payee, keys });
  return {
    chain, consensus, facilitator, services, payee, keys, handle,
    init: () => chain.init(),
    start: () => consensus.start(),
    stop: () => consensus.stop(),
  };
}
