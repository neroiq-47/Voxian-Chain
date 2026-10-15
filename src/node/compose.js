// Wires a full Voxian node (chain + x402 facilitator + paid services + API) independent of transport.
import { Blockchain, devnetKeys, MemoryStorage } from '../chain/blockchain.js';
import { DEFAULT_DEVNET_SECRET } from '../chain/keys.js';
import { deriveShieldedKeys } from '../zk/shielded.js';
import { Facilitator } from '../x402/facilitator.js';
import { createServices } from '../api/services.js';
import { createRouter } from '../api/router.js';

export function createNode({ storage = new MemoryStorage(), secret = DEFAULT_DEVNET_SECRET, now } = {}) {
  const keys = devnetKeys(secret);
  const chain = new Blockchain({ keys, storage, now });
  const facilitator = new Facilitator(chain, keys.facilitator);
  const services = createServices(chain);
  const shielded = deriveShieldedKeys(keys.serviceSeed);
  const payee = { address: keys.service.address, zaddress: shielded.zaddress, shielded };
  const handle = createRouter({ chain, facilitator, services, payee, keys });
  return {
    chain, facilitator, services, payee, keys, handle,
    init: () => chain.init(),
    start: () => chain.start(),
    stop: () => chain.stop(),
  };
}
