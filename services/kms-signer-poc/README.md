# kms-signer-poc

POC: sign Agoric wallet transactions with a secp256k1 key that is generated
inside Google Cloud KMS and never materializes in the service. Deployed as a
Cloud Run gen2 **function** (functions-framework, no Dockerfile).

This is a standalone unit. It vendors its KMS signer helper
(`src/kms-direct-signer.ts`) and depends only on published packages, so it
builds and deploys from its own directory without a monorepo build. It does not
modify `@agoric/client-utils` or any other agoric-sdk package. See the approved
design: `designs/kms-backed-agoric-signing.md`.

## What it does

- `src/kms-direct-signer.ts` — a CosmJS `OfflineDirectSigner` whose `signDirect`
  delegates to KMS `asymmetricSign` (`EC_SIGN_SECP256K1_SHA256`). It fetches the
  public key once, derives the `agoric1…` address, converts KMS's DER signature
  to a 64-byte compact `r||s` (KMS already returns low-S), and returns a
  CosmJS `StdSignature`. `makeStargateClientKitFromKms` wraps it in a
  `SigningStargateClient` with a registry that knows `MsgWalletSpendAction`.
- `src/index.ts` — the functions-framework HTTP entrypoint `sign`. Returns the
  derived address, and (when `RPC` is set and the request body carries a
  `spendAction`) signs and broadcasts a `MsgWalletSpendAction`.
- `src/config.ts` — reads `KMS_KEY_VERSION` (required, fully-qualified
  CryptoKeyVersion resource name), `PREFIX` (default `agoric`), `RPC`,
  `AGORIC_NET`. No key material in the environment.

## Configuration

| Env var          | Required | Description                                                                 |
| ---------------- | -------- | --------------------------------------------------------------------------- |
| `KMS_KEY_VERSION`| yes      | Fully-qualified KMS CryptoKeyVersion resource name (names which key signs).  |
| `PREFIX`         | no       | Bech32 prefix; defaults to `agoric`.                                         |
| `RPC`            | no       | CometBFT RPC endpoint; required to broadcast.                               |
| `AGORIC_NET`     | no       | Network spec, informational.                                                |

`KMS_KEY_VERSION` is a resource path, not key material, e.g.
`projects/<proj>/locations/<loc>/keyRings/<ring>/cryptoKeys/<key>/cryptoKeyVersions/<n>`.
One version is pinned per wallet because rotation changes the pubkey (=> new
address).

## Develop and test

```sh
yarn install     # from the repo root (workspace) or standalone in this dir
yarn test        # unit tests (no GCP calls)
yarn lint        # eslint + tsgo typecheck
yarn build       # tsc -> dist/
```

Integration tests that need a real KMS key are skipped unless
`RUN_KMS_INTEGRATION` is set (see `test/kms.integration.test.ts`).

## POC runbook

1. Create the keyring + key:
   ```sh
   gcloud kms keyrings create agoric --location us-central1
   gcloud kms keys create wallet0 --keyring agoric --location us-central1 \
     --purpose asymmetric-signing --default-algorithm ec-sign-secp256k1-sha256
   ```
2. Derive the address locally (ADC): run `yarn start` and `GET /` to print the
   `agoric1…` address; confirm it is well-formed.
3. Fund BLD/IST and provision the smart wallet:
   `agd tx swingset provision-one ... <address> SMART_WALLET`.
4. Run locally with `KMS_KEY_VERSION=projects/.../cryptoKeyVersions/1` and `RPC`;
   `POST` a `{ "spendAction": "…" }` body; confirm the tx lands.
5. Deploy the function (no Dockerfile; buildpacks):
   ```sh
   gcloud functions deploy kms-signer-poc --gen2 --runtime nodejs22 \
     --trigger-http --entry-point sign --source services/kms-signer-poc \
     --region us-central1 \
     --service-account <signing-sa> \
     --set-env-vars KMS_KEY_VERSION=projects/.../cryptoKeyVersions/1,RPC=<rpc>
   ```
   Grant the signing SA `roles/cloudkms.signerVerifier` (or least-privilege
   `useToSign` + `getPublicKey`) on that specific key. `@google-cloud/kms` picks
   up ADC from the metadata server — no key files, no mounted secrets.
6. Custody check: `gcloud kms keys versions get-public-key` works; confirm there
   is no export path. Wallet creation (`roles/cloudkms.admin`) is a separate
   provisioning SA from the signing SA.

## Custody notes

- No seed phrase: continuity == KMS key durability + IAM. Document backup and
  rotation; rotation mints a new address.
- The KMS wallet must hold BLD to pay fees, like any account.
