# Design: KMS-backed Agoric wallet signing on Cloud Run (POC)

Job: `20260714T192046Z-stallman` (design revision of `20260714T182329Z-knuth`,
addressing referee `20260714T183245Z-stallman` on PR #1). Supersedes PR #1.
Builds on research `20260714T181502Z-hamilton` (`research-brief.md`). Target fork:
`mujahidkai/agoric-sdk`.

## Goal

Sign Agoric txs with a secp256k1 key that is generated inside Google Cloud KMS and never
materializes in the service. Deliver two things: (1) a reusable KMS signer module in
`@agoric/client-utils`, and (2) a NEW standalone Cloud Run service that consumes it and
proves the flow end to end. Do NOT touch `ymax-planner` or any existing service. Do NOT
touch `agd`. Option A from the brief.

## Approach

One custom CosmJS `OfflineDirectSigner` that delegates `signDirect` to KMS `asymmetricSign`,
a drop-in wherever `DirectSecp256k1HdWallet` is used. `SigningStargateClient.connectWith
Signer` only ever calls `getAccounts` + `signDirect`, so the signer is fully compatible and
any consumer that expects `{address, client}` (as `signing-smart-wallet-kit.ts` returns) uses
it unchanged. The module is the reusable core; the new POC service is the first consumer.

## Reusable core: `packages/client-utils/src/kms-direct-signer.ts` (new)

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
  - `harden()` the returned signer and `harden()` the exported factory, per repo endo
    conventions (mirror `signing-smart-wallet-kit.ts`, which hardens both the returned kit
    and each exported function).
- `makeStargateClientKitFromKms({ keyVersionName, prefix = 'agoric', rpcAddr, connectWith
  Signer, kmsClient? }): Promise<{ address, client }>` — mirrors `makeStargateClientKit`,
  returns the identical `harden({ address, client })` shape (registry with
  `MsgWalletSpendAction`), a straight substitute for the mnemonic path.
- Optional convenience: `makeSigningSmartWalletKitFromKms(...)` mirroring
  `makeSigningSmartWalletKit(...)`, reusing the exported `makeSigningSmartWalletKitFromClient`.
  Keep KMS wiring OUT of `signing-client.ts` (that file stays mnemonic-only). This module is
  the only edit to existing code, and it only ADDS a file.

## Address derivation (getPublicKey → compress → bech32)

KMS `getPublicKey` returns a PEM/SPKI EC public key. Parse to the raw uncompressed point
via Node builtin `crypto.createPublicKey(pem).export({ format: 'jwk' })` → `{x, y}` (base64url)
→ `0x04 || x || y` (no extra dep). Then `Secp256k1.compressPubkey` (33 bytes) and
`address = toBech32(prefix, rawSecp256k1PubkeyToRawAddress(compressed))`
(`Secp256k1` from `@cosmjs/crypto`; `toBech32` from `@cosmjs/encoding`;
`rawSecp256k1PubkeyToRawAddress` + `encodeSecp256k1Signature` from `@cosmjs/amino`).

## Signature fix-up (DER → 64-byte compact)

KMS returns ASN.1 DER ECDSA, already low-S for secp256k1 (KMS guarantees lower-S; Cosmos
requires it — no extra normalization). `derToConcat`: parse DER → `{r, s}`, left-pad each to
32 bytes big-endian, concat. Prefer `Secp256k1Signature.fromDer(...).toFixedLength()`
(`@cosmjs/crypto`); fall back to a tiny DER reader only if needed. Guard the leading-zero /
short-integer cases explicitly.

## New service: `services/kms-signer-poc/` (new, the POC harness)

A standalone workspace package (`@aglocal/kms-signer-poc`, private) that CONSUMES the core
module — nothing in it changes existing services.

- `package.json`: deps `@agoric/client-utils` (workspace:*), `@google-cloud/kms`,
  `@cosmjs/proto-signing`, `@cosmjs/stargate`, `@cosmjs/crypto` (+ `@endo/init` for lockdown).
  Build via esbuild to a single `dist/entrypoint.js`, `ava` for any unit tests. Model the
  scripts/tsconfig/esbuild layout on `services/ymax-planner` (do not edit ymax-planner).
- `Dockerfile`: multi-stage `node:22-alpine`; corepack yarn; `yarn install --mode=skip-build`;
  build `packages/cosmic-proto`, `packages/client-utils`, then this service;
  `yarn workspaces focus @aglocal/kms-signer-poc --production`; copy `dist/entrypoint.js`; run
  as a non-root user. Model on the ymax-planner Dockerfile (no better-sqlite3/highs bindings
  needed here).
- `src/config.ts`: read `KMS_KEY_VERSION` (required), `RPC` / `AGORIC_NET`, `PREFIX`
  (default `agoric`) from env; no mnemonic, no Secret Manager.
- `src/main.ts` (entrypoint): build the KMS signer via `makeStargateClientKitFromKms` (or
  `makeSigningSmartWalletKitFromKms`), derive + PRINT the `agoric1…` address, then
  `signAndBroadcast` a `MsgWalletSpendAction` and print the result. This is the deployable
  proof; it exists only to exercise the reusable core.

## Files to change

- add `packages/client-utils/src/kms-direct-signer.ts` (new).
- `packages/client-utils/package.json`: add `@google-cloud/kms` (the only new external dep),
  and add `@cosmjs/encoding` + `@cosmjs/amino` as EXPLICIT direct deps (the module imports
  `toBech32`, `rawSecp256k1PubkeyToRawAddress`, `encodeSecp256k1Signature` from them; the
  repo's dependency-cruiser flags transitive imports).
- add `services/kms-signer-poc/` (new package: `package.json`, `Dockerfile`, `tsconfig*.json`,
  `esbuild.config.mjs`, `src/config.ts`, `src/main.ts`, `src/entrypoint.ts`, `src/lockdown.js`).
- root workspace/lockfile picks up the new package (`yarn install`).
- NO edits to `services/ymax-planner/*` or any other existing service.

## GCP wiring

- KMS: keyring + one `ASYMMETRIC_SIGN` / `EC_SIGN_SECP256K1_SHA256` CryptoKey per wallet
  (SOFTWARE for POC, HSM for prod). No mnemonic, no HD derivation — pin one key version per
  wallet (rotation changes the pubkey ⇒ new address).
- Cloud Run: deploy the NEW `kms-signer-poc` service with a dedicated user-managed SA as its
  identity (`--service-account`); grant that SA `roles/cloudkms.signerVerifier` (or
  least-privilege `useToSign` + `getPublicKey`) on that specific key. `@google-cloud/kms`
  picks up ADC from the metadata server — no key files, no mounted secrets.
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
  `agoric1…`; `getAccounts` shape; `signDirect` output verifies against the compressed
  pubkey with a mocked `kmsClient`. Signer/kit are hardened (frozen).
- Integration proof (runbook, manual): create key → derive/print address → fund + `agd tx
  swingset provision-one <addr> SMART_WALLET` → `signAndBroadcast` a `MsgWalletSpendAction`
  via the KMS signer → tx lands; cross-check recovered signer pubkey == KMS pubkey.
- Cloud Run: deploy the NEW `kms-signer-poc` service with `--service-account` +
  `signerVerifier` and `KMS_KEY_VERSION` env; confirm signing with no key material in
  env/secrets.

## POC runbook

1. `gcloud kms keyrings create agoric --location us-central1`;
   `gcloud kms keys create wallet0 --keyring agoric --location us-central1
   --purpose asymmetric-signing --default-algorithm ec-sign-secp256k1-sha256`.
2. Local ADC script: `getPublicKey` → compress → bech32; confirm well-formed `agoric1…`.
3. Fund BLD/IST; `agd tx swingset provision-one ... <address> SMART_WALLET`.
4. Build + run `kms-signer-poc` locally with `KMS_KEY_VERSION=projects/.../cryptoKeyVersions/1`
   and `RPC`; it prints the address and `signAndBroadcast`s a spend action; verify it lands.
5. Build the image and deploy `kms-signer-poc` to Cloud Run with the signing SA +
   `signerVerifier`; re-run; confirm no secrets and the tx lands.
6. Custody check: `gcloud kms keys versions get-public-key` works; confirm no export path.

## Out of scope

- Modifying `ymax-planner` or ANY existing service (maintainer directive on PR #1): the POC
  is a new standalone Cloud Run service that only consumes the reusable core.
- Any `agd` / cosmos-sdk Go keyring backend (brief Option C).
- Import-a-seed-into-KMS (Option B — violates "key never in the service").
- Multi-wallet / HD subaccounts, key rotation automation, DR tooling.
- Carrying anything to upstream `Agoric/agoric-sdk`.
</content>
</invoke>
