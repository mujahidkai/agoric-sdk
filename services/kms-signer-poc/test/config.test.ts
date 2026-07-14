import test from 'ava';

import { loadConfig } from '../src/config.ts';

const VALID_KEY_VERSION =
  'projects/my-proj/locations/us-central1/keyRings/agoric/cryptoKeys/wallet0/cryptoKeyVersions/1';

test('loadConfig requires KMS_KEY_VERSION', t => {
  t.throws(() => loadConfig({}), { message: 'KMS_KEY_VERSION is required' });
  t.throws(() => loadConfig({ KMS_KEY_VERSION: '   ' }), {
    message: 'KMS_KEY_VERSION is required',
  });
});

test('loadConfig rejects a non-fully-qualified key version', t => {
  t.throws(() => loadConfig({ KMS_KEY_VERSION: 'wallet0' }), {
    message: /fully-qualified CryptoKeyVersion resource name/,
  });
  t.throws(
    () =>
      loadConfig({
        KMS_KEY_VERSION:
          'projects/p/locations/l/keyRings/r/cryptoKeys/k', // missing cryptoKeyVersions/<n>
      }),
    { message: /fully-qualified CryptoKeyVersion resource name/ },
  );
});

test('loadConfig accepts a valid key version and defaults prefix to agoric', t => {
  const config = loadConfig({ KMS_KEY_VERSION: VALID_KEY_VERSION });
  t.is(config.keyVersionName, VALID_KEY_VERSION);
  t.is(config.prefix, 'agoric');
  t.is(config.rpcAddr, undefined);
  t.is(config.agoricNet, undefined);
});

test('loadConfig honors PREFIX, RPC and AGORIC_NET overrides', t => {
  const config = loadConfig({
    KMS_KEY_VERSION: VALID_KEY_VERSION,
    PREFIX: 'cosmos',
    RPC: 'https://rpc.example.invalid:443',
    AGORIC_NET: 'devnet',
  });
  t.is(config.prefix, 'cosmos');
  t.is(config.rpcAddr, 'https://rpc.example.invalid:443');
  t.is(config.agoricNet, 'devnet');
});

test('loadConfig trims whitespace', t => {
  const config = loadConfig({
    KMS_KEY_VERSION: `  ${VALID_KEY_VERSION}  `,
    PREFIX: '  agoric  ',
  });
  t.is(config.keyVersionName, VALID_KEY_VERSION);
  t.is(config.prefix, 'agoric');
});
