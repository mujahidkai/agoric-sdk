# Design: KMS-backed Agoric wallet signing on Cloud Run (POC)

Job: `20260714T192046Z-stallman` (design revision of `20260714T182329Z-knuth`,
addressing referee `20260714T183245Z-stallman` on PR #1). Supersedes PR #1.
Revised again per maintainer comments on PR #2 (job `20260714T200302Z-karp`).
Builds on research `20260714T181502Z-hamilton` (`research-brief.md`). Target fork:
`mujahidkai/agoric-sdk`.

## Goal

Sign Agoric txs with a secp256k1 key that is generated inside Google Cloud KMS and never
materializes in the service. Deliver ONE self-contained POC unit under
`services/kms-signer-poc/` that (1) vendors its own KMS signer helper
(`kms-direct-signer.ts`) and (2) proves the flow end to end, deployed as a Cloud Run
function (serverless). Do NOT modify ANY existing agoric-sdk package (including
`@agoric/client-utils`), `ymax-planner`, any other service, or `agd`. Option A from the
brief.

Revision note (PR #2 maintainer comments): the prior draft added the signer to
`@agoric/client-utils` and shipped a containerized Cloud Run service. Per the maintainer,
the POC now (a) vendors the helper inside the POC unit so no agoric-sdk package is touched,
and (b) targets a Cloud Run function (serverless), not a container service. Promoting the
helper into `@agoric/client-utils` as a reusable module is a deliberate follow-up, out of
scope here.

## Approach

One custom CosmJS `OfflineDirectSigner` that delegates `signDirect` to KMS `asymmetricSign`,
a drop-in wherever `DirectSecp256k1HdWallet` is used. `SigningStargateClient.connectWith
Signer` only ever calls `getAccounts` + `signDirect`, so the signer is fully compatible and
any consumer that expects `{address, client}` uses it unchanged. The helper is vendored
inside the POC unit (added to no agoric-sdk package); the POC function is its only consumer.

## KMS signer helper: `services/kms-signer-poc/src/kms-direct-signer.ts` (new, vendored)

Self-contained in the POC unit. No edits to `@agoric/client-utils` or any other sdk package.

- `makeKmsDirectSigner({ keyVersionName, prefix = 'agoric', kmsClient? }): Promise<Offline
  DirectSigner>` — the core deliverable.
  - Constructor fetches the public key once (`kms.getPublicKey({ name: keyVersionName })`),
    derives address + compressed pubkey, caches both (one KMS round-trip, not per-call).
  - `getAccounts()` -> `[{ address, algo: 'secp256k1', pubkey: compressedPubkey }]`.
  - `signDirect(signerAddress, signDoc)`:
    - assert `signerAddress === address`;
    - `digest = sha256(makeSignBytes(signDoc))` (`@cosmjs/proto-signing`);
    - `[res] = await kms.asymmetricSign({ name: keyVersionName, digest: { sha256: digest }})`;
    - `sig64 = derToConcat(res.signature)` -> 64-byte `r||s`;
    - return `{ signed: signDoc, signature: encodeSecp256k1Signature(compressedPubkey, sig64) }`.
- `makeStargateClientKitFromKms({ keyVersionName, prefix = 'agoric', rpcAddr, kmsClient? }):
  Promise<{ address, client }>` — builds a `SigningStargateClient` over the KMS signer with a
  registry that includes `MsgWalletSpendAction` (type from the published `@agoric/cosmic-proto`);
  returns the `{ address, client }` shape, a straight substitute for the mnemonic path.
- `harden()` the returned signer and the exported factories, per endo conventions, when the
  POC runtime has run `lockdown()` (see the function-runtime note under GCP wiring). The helper
  itself imports no agoric-sdk internals; it depends only on `@cosmjs/*`, `@google-cloud/kms`,
  and the published `@agoric/cosmic-proto` for the message type.

## Address derivation (getPublicKey -> compress -> bech32)

KMS `getPublicKey` returns a PEM/SPKI EC public key. Parse to the raw uncompressed point
via Node builtin `crypto.createPublicKey(pem).export({ format: 'jwk' })` -> `{x, y}` (base64url)
-> `0x04 || x || y` (no extra dep). Then `Secp256k1.compressPubkey` (33 bytes) and
`address = toBech32(prefix, rawSecp256k1PubkeyToRawAddress(compressed))`
(`Secp256k1` from `@cosmjs/crypto`; `toBech32` from `@cosmjs/encoding`;
`rawSecp256k1PubkeyToRawAddress` + `encodeSecp256k1Signature` from `@cosmjs/amino`).

## Signature fix-up (DER -> 64-byte compact)

KMS returns ASN.1 DER ECDSA, already low-S for secp256k1 (KMS guarantees lower-S; Cosmos
requires it — no extra normalization). `derToConcat`: parse DER -> `{r, s}`, left-pad each to
32 bytes big-endian, concat. Prefer `Secp256k1Signature.fromDer(...).toFixedLength()`
(`@cosmjs/crypto`); fall back to a tiny DER reader only if needed. Guard the leading-zero /
short-integer cases explicitly.

## POC unit: `services/kms-signer-poc/` (new, deployed as a Cloud Run function)

A standalone, self-contained package (`@aglocal/kms-signer-poc`, private). It does NOT depend
on any workspace package; it uses published deps only, so it builds and deploys from its own
directory without a monorepo build. Nothing in it changes existing services.

- `package.json`: deps `@google-cloud/kms`, `@cosmjs/proto-signing`, `@cosmjs/stargate`,
  `@cosmjs/crypto`, `@cosmjs/encoding`, `@cosmjs/amino`, the published `@agoric/cosmic-proto`
  (for `MsgWalletSpendAction`), and `@google-cloud/functions-framework` for the entrypoint.
  No `workspace:*` deps. No Dockerfile (Cloud Run functions build the source with buildpacks).
- `src/config.ts`: read `KMS_KEY_VERSION` (required), `RPC` / `AGORIC_NET`, `PREFIX`
  (default `agoric`) from env; no mnemonic, no Secret Manager.
  - `KMS_KEY_VERSION` is the fully-qualified GCP KMS **CryptoKeyVersion resource name** that
    the signer passes as `keyVersionName` to `getPublicKey` / `asymmetricSign`, e.g.
    `projects/<proj>/locations/<loc>/keyRings/<ring>/cryptoKeys/<key>/cryptoKeyVersions/<n>`.
    It names WHICH key version signs; it is a resource path, not key material (nothing secret
    is in env). One version is pinned per wallet because rotation changes the pubkey (=> new
    address).
- `src/index.ts` (entrypoint): a functions-framework HTTP handler (`functions.http('sign', ...)`)
  that builds the KMS signer via `makeStargateClientKitFromKms`, derives + returns the
  `agoric1…` address, then `signAndBroadcast`s a `MsgWalletSpendAction` and returns the result.
  This is the deployable proof; it exists only to exercise the vendored helper.

## Files to change

- add `services/kms-signer-poc/` (new self-contained package): `package.json`, `tsconfig*.json`,
  `esbuild.config.mjs` (or `tsc` build), `src/config.ts`, `src/index.ts`,
  `src/kms-direct-signer.ts` (the vendored helper), `src/lockdown.js` (optional, best-effort).
- root workspace/lockfile picks up the new package (`yarn install`); the package pins published
  versions so it also builds standalone from its own directory for `gcloud functions deploy`.
- NO edits to `packages/client-utils/*`, `services/ymax-planner/*`, or any other existing
  package or service. No agoric-sdk package update of any kind.

## GCP wiring

- KMS: keyring + one `ASYMMETRIC_SIGN` / `EC_SIGN_SECP256K1_SHA256` CryptoKey per wallet
  (SOFTWARE for POC, HSM for prod). No mnemonic, no HD derivation — pin one key version per
  wallet (rotation changes the pubkey => new address).
- Cloud Run function: `gcloud functions deploy kms-signer-poc --gen2 --runtime nodejs22
  --trigger-http --entry-point sign --source services/kms-signer-poc --region us-central1`
  with a dedicated user-managed SA as its identity (`--service-account`); grant that SA
  `roles/cloudkms.signerVerifier` (or least-privilege `useToSign` + `getPublicKey`) on that
  specific key. `@google-cloud/kms` picks up ADC from the metadata server — no key files, no
  mounted secrets. (2nd-gen Cloud Run functions run on the same Cloud Run substrate, so the
  identity/IAM story is identical to a service; we just skip the Dockerfile/container.)
- Function-runtime note: `@endo/init` `lockdown()` mutates intrinsics and must run before
  other modules load. Under functions-framework the framework loads first, so `lockdown()` is
  best-effort for this POC and `harden()` is applied only when it ran; CosmJS signing does not
  require SES. The hardened, lockdown-first path belongs to the future `@agoric/client-utils`
  module (out of scope here).
- Role separation: wallet creation (`roles/cloudkms.admin`) is an operator/provisioning step
  on a different SA from the signing SA (`signerVerifier`).

## Edge cases

- DER integer leading-zero / <32-byte r or s → left-pad; fuzz many signatures.
- `signerAddress` mismatch → `Fail`. Unknown/short PEM curve → reject.
- KMS latency/quota: cache pubkey+address; one `asymmetricSign` per signature.
- Fee account: KMS wallet must hold BLD to pay fees (same as any account).
- No seed-phrase recovery: continuity == KMS key durability + IAM; document backup/rotation.
- Cloud Run function cold start: fetch+cache the pubkey per instance; a warm instance reuses it.

## Test plan

- Unit (ava, `@cosmjs/crypto` `Secp256k1.verifySignature`): `derToConcat` round-trips vs
  known DER vectors incl. padded r/s; address derivation from a fixed pubkey equals a known
  `agoric1…`; `getAccounts` shape; `signDirect` output verifies against the compressed
  pubkey with a mocked `kmsClient`.
- Integration proof (runbook, manual): create key → derive/print address → fund + `agd tx
  swingset provision-one <addr> SMART_WALLET` → `signAndBroadcast` a `MsgWalletSpendAction`
  via the KMS signer → tx lands; cross-check recovered signer pubkey == KMS pubkey.
- Cloud Run function: deploy with `--service-account` + `signerVerifier` and `KMS_KEY_VERSION`
  env; invoke the HTTP endpoint; confirm signing with no key material in env/secrets.

## POC runbook

1. `gcloud kms keyrings create agoric --location us-central1`;
   `gcloud kms keys create wallet0 --keyring agoric --location us-central1
   --purpose asymmetric-signing --default-algorithm ec-sign-secp256k1-sha256`.
2. Local ADC script: `getPublicKey` → compress → bech32; confirm well-formed `agoric1…`.
3. Fund BLD/IST; `agd tx swingset provision-one ... <address> SMART_WALLET`.
4. Build + run `kms-signer-poc` locally (functions-framework) with
   `KMS_KEY_VERSION=projects/.../cryptoKeyVersions/1` and `RPC`; hit the endpoint; it returns
   the address and `signAndBroadcast`s a spend action; verify it lands.
5. `gcloud functions deploy kms-signer-poc --gen2 ...` with the signing SA + `signerVerifier`
   and `KMS_KEY_VERSION`; invoke it; confirm no secrets and the tx lands.
6. Custody check: `gcloud kms keys versions get-public-key` works; confirm no export path.

## Out of scope

- Modifying `@agoric/client-utils`, `ymax-planner`, or ANY existing package/service (maintainer
  directive on PR #1 and PR #2): the POC is a new self-contained unit that vendors its own helper.
- Promoting the vendored `kms-direct-signer.ts` into `@agoric/client-utils` as a reusable,
  lockdown-first module (a deliberate follow-up once the POC proves the flow).
- Any `agd` / cosmos-sdk Go keyring backend (brief Option C).
- Import-a-seed-into-KMS (Option B — violates "key never in the service").
- Multi-wallet / HD subaccounts, key rotation automation, DR tooling.
- Carrying anything to upstream `Agoric/agoric-sdk`.
