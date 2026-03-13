import type { SupplyChainServiceHandler } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getShippingRates } from './get-shipping-rates.ts';
import { getChokepointStatus } from './get-chokepoint-status.ts';
import { getCriticalMinerals } from './get-critical-minerals.ts';

export const supplyChainHandler: SupplyChainServiceHandler = {
  getShippingRates,
  getChokepointStatus,
  getCriticalMinerals,
};
