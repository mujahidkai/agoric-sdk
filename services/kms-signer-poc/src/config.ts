/**
 * Environment configuration for the kms-signer-poc Cloud Run function.
 *
 * No key material lives in the environment: `KMS_KEY_VERSION` is only a resource
 * path naming WHICH KMS key version signs. See designs/kms-backed-agoric-signing.md.
 */

/** Matches a fully-qualified GCP KMS CryptoKeyVersion resource name. */
export const KMS_KEY_VERSION_PATTERN =
  /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[^/]+$/;

export interface KmsSignerConfig {
  /** Fully-qualified KMS CryptoKeyVersion resource name. */
  readonly keyVersionName: string;
  /** Bech32 address prefix. */
  readonly prefix: string;
  /** Tendermint/CometBFT RPC endpoint (optional; required to broadcast). */
  readonly rpcAddr?: string;
  /** Agoric network spec (optional; informational for the POC). */
  readonly agoricNet?: string;
}

const required = (
  env: Record<string, string | undefined>,
  name: string,
): string => {
  const value = env[name]?.trim();
  if (!value) {
    throw Error(`${name} is required`);
  }
  return value;
};

/**
 * Build the POC config from an environment map. Validates that
 * `KMS_KEY_VERSION` is a well-formed CryptoKeyVersion resource name so a
 * mistyped key ring or a bare key name fails fast rather than at first sign.
 */
export const loadConfig = (
  env: Record<string, string | undefined>,
): KmsSignerConfig => {
  const keyVersionName = required(env, 'KMS_KEY_VERSION');
  if (!KMS_KEY_VERSION_PATTERN.test(keyVersionName)) {
    throw Error(
      'KMS_KEY_VERSION must be a fully-qualified CryptoKeyVersion resource name ' +
        '(projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>/cryptoKeyVersions/<n>)',
    );
  }

  const prefix = env.PREFIX?.trim() || 'agoric';
  const rpcAddr = env.RPC?.trim() || undefined;
  const agoricNet = env.AGORIC_NET?.trim() || undefined;

  const h = (globalThis as { harden?: <U>(v: U) => U }).harden;
  const config: KmsSignerConfig = { keyVersionName, prefix, rpcAddr, agoricNet };
  return h ? h(config) : config;
};
