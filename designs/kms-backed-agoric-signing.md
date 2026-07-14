# Design: KMS-backed Agoric wallet signing on Cloud Run (POC)

Job: `20260714T182329Z-knuth` (design). Builds on research
`20260714T181502Z-hamilton` (`research-brief.md`). Target fork: `mujahidkai/agoric-sdk`.

## Goal

Sign Agoric txs with a secp256k1 key that is generated inside Google Cloud KMS and never
materializes in the service. Prove it via `ymax-planner` on Cloud Run: swap the Secret
Manager mnemonic for a KMS key version, key custody strictly stronger, no other behavior
change. Option A from the brief. Do NOT touch `agd`.

## Approach

One custom CosmJS `OfflineDirectSigner` that delegates `signDirect` to KMS `asymmetricSign`,
dropped in exactly where `DirectSecp256k1HdWallet` is used. `SigningStargateClient.connect
WithSigner` only ever calls `getAccounts` + `signDirect`, so the drop-in is fully compatible
and downstream (`signing-smart-wallet-kit.ts`, `ymax-planner`) consume `{address, client}`
unchanged.

## New module: `packages/client-utils/src/kms-direct-signer.ts`

- `makeKmsDirectSigner({ keyVersionName, prefix = 'agoric', kmsClient? }): Promise<Offline
  DirectSigner>` — the core deliverable.
  - Constructor fetches the public key once (`kms.getPublicKey({ name: keyVersionName })`),
    derives address + compressed pubkey, caches both (one KMS round-trip, not per-call).
  - `getAccounts()` → `[{ address, algo: 'secp256k1', pubkey: compressedPubkey }]`.
  - `signDirect(signerAddress, signDoc)`:
    - assert `signerAddress === address`;
    - `digest = sha256(makeSignBytes(signDoc))` (`@cosmjs/proto-signing`);
    - `[res] = await kms.asymmetricSign({ name: keyVersionName, digest: { sha256: digest }})`;
    - `sig64 = derToConcat(res.signature)` → 64-byte `r||s`;
    - return `{ signed: signDoc, signature: encodeSecp256k1Signature(compressedPubkey, sig64) }`.
- `makeStargateClientKitFromKms({ keyVersionName, prefix = 'agoric', rpcAddr, connectWith
  Signer, kmsClient? }): Promise<{ address, client }>` — mirrors `makeStargateClientKit`,
  returns the identical shape (registry with `MsgWalletSpendAction`), so it is a straight
  substitute in `signing-smart-wallet-kit.ts`.
- Optional convenience: `makeSigningSmartWalletKitFromKms(...)` mirroring
  `makeSigningSmartWalletKit(...)` in `signing-smart-wallet-kit.ts`, sharing
  `makeSigningSmartWalletKitFromClient`. Keep the KMS wiring out of `signing-client.ts`
  (that file stays mnemonic-only).

## Address derivation (getPublicKey → compress → bech32)

KMS `getPublicKey` returns a PEM/SPKI EC public key. Parse to the raw uncompressed point
via Node builtin `crypto.createPublicKey(pem).export({ format: 'jwk' })` → `{x, y}` (base64url)
→ `0x04 || x || y` (no extra dep). Then `Secp256k1.compressPubkey` (33 bytes),
`address = toBech32(prefix, ripemd160(sha256(compressed)))`
(`Secp256k1`, `sha256`, `Ripemd160` from `@cosmjs/crypto`; `toBech32` from `@cosmjs/encoding`;
or `rawSecp256k1PubkeyToRawAddress` from `@cosmjs/amino`).

## Signature fix-up (DER → 64-byte compact)

KMS returns ASN.1 DER ECDSA, already low-S for secp256k1 (KMS guarantees lower-S; Cosmos
requires it — no extra normalization). `derToConcat`: parse DER → `{r, s}`, left-pad each to
32 bytes big-endian, concat. Prefer `Secp256k1Signature.fromDer(...).toFixedLength()`
(`@cosmjs/crypto`); fall back to a tiny DER reader only if needed. Guard the leading-zero /
short-integer cases explicitly.

## Files to change

- add `packages/client-utils/src/kms-direct-signer.ts` (new).
- `packages/client-utils/package.json`: add `@google-cloud/kms` (the only new external dep).
  `@cosmjs/amino` + `@cosmjs/encoding` are already present transitively via
  `@cosmjs/proto-signing`/`@cosmjs/stargate`; add them explicitly for hygiene if lint requires.
- `services/ymax-planner/src/config.ts`: add `SIGNER` (`'mnemonic'` default | `'kms'`) and
  `KMS_KEY_VERSION`; when `SIGNER=kms`, skip `getMnemonicFromGCP`, require `KMS_KEY_VERSION`,
  carry it on the config (make `mnemonic` optional in that branch).
- `services/ymax-planner/src/main.ts` (~234): branch — `SIGNER=kms` → `makeStargateClientKit
  FromKms` (or `makeSigningSmartWalletKitFromKms`); else the existing mnemonic path. No change
  to `sendBridgeAction`/dry-run logic.
- `services/ymax-planner/package.json`: add `@google-cloud/kms`.

## GCP wiring

- KMS: keyring + one `ASYMMETRIC_SIGN` / `EC_SIGN_SECP256K1_SHA256` CryptoKey per wallet
  (SOFTWARE for POC, HSM for prod). No mnemonic, no HD derivation — pin one key version per
  wallet (rotation changes the pubkey ⇒ new address).
- Cloud Run: dedicated user-managed SA as service identity (`--service-account`); grant it
  `roles/cloudkms.signerVerifier` (or least-privilege `useToSign` + `getPublicKey`) on that
  specific key. `@google-cloud/kms` picks up ADC from the metadata server — no key files, no
  mounted secrets.
- Role separation: wallet creation (`roles/cloudkms.admin`) is an operator/provisioning step
  on a different SA from the signing SA (`signerVerifier`).

## Edge cases

- DER integer leading-zero / <32-byte r or s → left-pad; fuzz many signatures.
- `signerAddress` mismatch → `Fail`. Unknown/short PEM curve → reject.
- KMS latency/quota: cache pubkey+address; one `asymmetricSign` per signature.
- Fee account: KMS wallet must hold BLD to pay fees (same as any account).
- No seed-phrase recovery: continuity == KMS key durability + IAM; document backup/rotation.

## Test plan

- Unit (ava, `@cosmjs/crypto` `Secp256k1.verifySignature`): `derToConcat` round-trips vs
  known DER vectors incl. padded r/s; address derivation from a fixed pubkey equals a known
  `agoric1...`; `getAccounts` shape; `signDirect` output verifies against the compressed
  pubkey with a mocked `kmsClient`.
- Integration proof (runbook, manual): create key → derive/print address → fund + `agd tx
  swingset provision-one <addr> SMART_WALLET` → `signAndBroadcast` a `MsgWalletSpendAction`
  via the KMS signer → tx lands; cross-check recovered signer pubkey == KMS pubkey.
- Cloud Run: deploy with `--service-account` + `signerVerifier`, `KMS_KEY_VERSION` env,
  confirm signing with no key material in env/secrets.

## POC runbook

1. `gcloud kms keyrings create agoric --location us-central1`;
   `gcloud kms keys create wallet0 --keyring agoric --location us-central1
   --purpose asymmetric-signing --default-algorithm ec-sign-secp256k1-sha256`.
2. Local ADC script: `getPublicKey` → compress → bech32; confirm well-formed `agoric1...`.
3. Fund BLD/IST; `agd tx swingset provision-one ... <address> SMART_WALLET`.
4. Set `SIGNER=kms KMS_KEY_VERSION=projects/.../cryptoKeyVersions/1`; run `ymax-planner`;
   `signAndBroadcast` a spend action; verify it lands.
5. Deploy to Cloud Run with the signing SA + `signerVerifier`; re-run; confirm no secrets.
6. Custody check: `gcloud kms keys versions get-public-key` works; confirm no export path.

## Out of scope

- Any `agd` / cosmos-sdk Go keyring backend (brief Option C).
- Import-a-seed-into-KMS (Option B — violates "key never in the service").
- Multi-wallet / HD subaccounts, key rotation automation, DR tooling.
- Carrying anything to upstream `Agoric/agoric-sdk`.
