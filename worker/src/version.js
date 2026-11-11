// GET /version: which app versions this worker still serves. Rules: docs/WORKER.md section 12.
// API_VERSION goes up only for a change that old apps cannot read (the contract test in
// tests/worker-contract.test.mjs fails first). MIN_APP_VERSION goes up only when an older app really breaks.
export const API_VERSION = 1;
export const MIN_APP_VERSION = '0.9.0-beta.1';

export const versionBody = () => ({ api: API_VERSION, minApp: MIN_APP_VERSION });
