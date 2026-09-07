#!/usr/bin/env node

const result = {
  ok: false,
  schemaVersion: 'speak.calltools.direct-proof-unsupported.v1',
  error: 'calltools_direct_proof_unsupported',
  mutationPerformed: false,
  retiredPath: 'direct_automated_proof',
  supportedPath: 'native_campaign_invite',
  supportedCommand:
    'npm run qa:calltools-live-proof -- --require-complete --callControlId=<call-control-id>',
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = 1;
