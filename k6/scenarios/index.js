// Picks the scenario for TARGET_PROFILE. The test scripts only talk to this
// module, so adding a new target = adding one scenario file + one line here.
import { PROFILE, WEIGHTS_OVERRIDE } from '../config.js';
import { registerEndpoints } from '../utils/api.js';
import * as retail from './customer-journey.js';
import * as quickpizza from './quickpizza.js';

const SCENARIOS = { 'retail-mock': retail, quickpizza };

export const scenario = SCENARIOS[PROFILE];
registerEndpoints(scenario.ENDPOINTS);
export const ENDPOINT_KEYS = Object.keys(scenario.ENDPOINTS);
// Effective traffic mix: WEIGHTS env override, else the scenario's defaults.
export const WEIGHTS = WEIGHTS_OVERRIDE || scenario.DEFAULT_WEIGHTS;
