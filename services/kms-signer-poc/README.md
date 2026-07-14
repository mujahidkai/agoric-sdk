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
- `src/index.ts` — the functions-framework HTTP entrypoint `sign`. Selects a
  wallet (`wallet` index), returns its address and (when `RPC` is set) its BLD
  balance; enumerates all wallets (`action: "list"`); provisions the smart
  wallet (`action: "provision"`); or signs and broadcasts a
  `MsgWalletSpendAction` (`spendAction`).
- `src/config.ts` — reads `KMS_KEY_VERSION` / `KMS_KEY_VERSIONS` (required;
  fully-qualified CryptoKeyVersion resource name(s)), `PREFIX` (default
  `agoric`), `RPC`, `AGORIC_NET`. No key material in the environment.

## Configuration

| Env var           | Required | Description                                                                          |
| ----------------- | -------- | ------------------------------------------------------------------------------------ |
| `KMS_KEY_VERSION` | yes\*    | Fully-qualified KMS CryptoKeyVersion resource name (one wallet).                      |
| `KMS_KEY_VERSIONS`| yes\*    | Comma/newline-separated list of resource names to run several wallets from one deploy.|
| `PREFIX`          | no       | Bech32 prefix; defaults to `agoric`.                                                  |
| `RPC`             | no       | CometBFT RPC endpoint; required to broadcast (and to report balances).               |
| `AGORIC_NET`      | no       | Network spec, informational.                                                          |

\* Provide exactly one of `KMS_KEY_VERSION` or `KMS_KEY_VERSIONS`. Both are
resource paths, not key material, e.g.
`projects/<proj>/locations/<loc>/keyRings/<ring>/cryptoKeys/<key>/cryptoKeyVersions/<n>`.

### Multiple wallets

A GCP KMS CryptoKeyVersion **is** one secp256k1 keypair, so it maps to exactly
one `agoric1…` address. The private key never leaves KMS and is not HD/BIP-32
derivable, so there is no single seed from which many child addresses descend:
**each wallet is its own key version.** That is the deliberate custody tradeoff
of non-exportable keys — you give up cheap HD derivation to keep every key inside
the HSM.

Scaling is operational, not one-key-many-addresses: create N key versions (or N
keys), list them all in `KMS_KEY_VERSIONS`, and a single deployed function
manages them. A request picks which one signs with `wallet` (an index, default
`0`); `action: "list"` returns every wallet's index and address. (Note: rotating
a key mints a new version and therefore a new address, so rotation is a
migration, not a transparent swap.)

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
2. Derive the address locally (ADC): run `yarn start` and hit the function to
   print the `agoric1…` address; confirm it is well-formed. With several wallets
   configured, `{ "action": "list" }` prints them all, and `{ "wallet": <i> }`
   selects one.
3. **Fund the wallet.** A fresh KMS wallet starts empty and cannot fund itself,
   so BLD has to arrive from outside — a faucet (dev/test nets) or a transfer
   from an already-funded account:
   ```sh
   agd tx bank send <funder> <address> 25000000ubld --from <funder> ...
   ```
   The service does not (and cannot) do this step; with `RPC` set, the address
   response reports `balance`/`funded` so you can confirm the funds landed.
4. **Provision the smart wallet.** A wallet cannot run wallet actions until it is
   provisioned, and provisioning itself is a fee-paying tx — hence step 3 first.
   The service self-submits `MsgProvision` (SMART_WALLET) signed by the KMS key:
   `POST { "action": "provision" }` (add `"wallet": <i>` to pick a wallet). It
   refuses with a clear error if the wallet holds no BLD. Equivalent CLI:
   `agd tx swingset provision-one kms-wallet <address> SMART_WALLET --from <address>`.
5. Run locally with `RPC` set; `POST { "spendAction": "…" }` (optionally
   `"wallet": <i>`); confirm the tx lands. The handler refuses to broadcast an
   unfunded wallet.
6. Deploy the function (no Dockerfile; buildpacks):
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
7. Custody check: `gcloud kms keys versions get-public-key` works; confirm there
   is no export path. Wallet creation (`roles/cloudkms.admin`) is a separate
   provisioning SA from the signing SA.

## Custody notes

- No seed phrase: continuity == KMS key durability + IAM. Document backup and
  rotation; rotation mints a new address.
- The KMS wallet must hold BLD to pay fees, like any account.
