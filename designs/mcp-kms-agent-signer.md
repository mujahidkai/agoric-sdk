# Design: MCP server for KMS-backed Agoric agent-wallet signing on GCP

Job `20260716T120327Z-kernighan`. Builds on research-brief.md
(`lab/research/20260716T115350Z-shamir`), the approved POC design
`designs/kms-backed-agoric-signing.md`, and `services/kms-signer-poc/`.
Authoritative human decisions (2026-07-16) override the brief where they differ:
Neon (Postgres) store, token-carried user+agent addresses with server-side tx
build, and isolation Model A.

## Goal

Ship a new self-contained unit `services/mcp-agent-signer/` (a Cloud Run MCP
server) that mints per-user agent wallets as non-exportable GCP KMS
secp256k1 keys and signs/broadcasts Agoric transactions on their behalf. No
existing agoric-sdk package is modified. Funding, key-ring creation, and the
concrete authN/authZ implementation stay out of scope.

## Approach

- Reuse the POC signer core verbatim: factor `kms-direct-signer.ts`
  (`makeKmsDirectSigner`, `makeStargateClientKitFromKms`,
  `compressedPubkeyFromPem`, `addressFromCompressedPubkey`) and
  `KMS_KEY_VERSION_PATTERN` into an internal module of the new unit (copy/vendor;
  do not import across into the POC package). Same repo conventions: ESM TS,
  `tsc -p tsconfig.build.json`, ava via `ts-blank-space/register`, `@aglocal/*`
  private name, published deps only, node `^22.11`, best-effort `harden()`.
- Runtime: a Cloud Run **service** (long-lived), not the POC gen2 function,
  running an `@modelcontextprotocol/sdk` server over **Streamable HTTP** at
  `/mcp`. Deploy with `--no-allow-unauthenticated`; callers need
  `roles/run.invoker`. Identity/ADC/KMS story is identical to the POC.

## Auth model (confirmed decision 2)

- One seam: `getVerifiedAuth(request) -> { userAddress, agentAddress }`. The
  verified token carries BOTH the authenticated user-addr and the agent-addr.
  Clients NEVER pass an opaque agentId, NEVER a key name, and NEVER a
  pre-serialized tx / spendAction payload.
- The MCP tool builds `MsgWalletSpendAction` SERVER-SIDE from structured intent
  args: it serializes the spendAction string itself, sets `owner` = the agent
  address (bytes), and signs. `provision` builds `MsgProvision` likewise.
- The server MUST still verify `record.owner_user_address === token.userAddress`
  against the store before signing (belt-and-suspenders, and required anyway to
  resolve `keyVersion` — KMS has no reverse address->key lookup).

## Store (confirmed decision 1)

- Existing **Neon (Postgres)** instance is the authZ source of truth (replaces
  the brief's Firestore and the POC's `KMS_KEY_VERSIONS` env roster). Co-locate
  same-region with the Cloud Run service.
- Access via Neon's **pooled endpoint (PgBouncer)** or the **serverless driver
  (HTTP/WS)** — never a naive per-instance TCP pool (Cloud Run scales to many
  short-lived instances). Connection string from Secret Manager.
- Table `agent_wallets`:
  `agent_address PK, owner_user_address, key_version (KMS resource name),
   prefix, protection_level, status (pending|enabled|disabled), label,
   created_at`. Enforce one-key-per-agent idempotency with
  `UNIQUE(owner_user_address, agent_address)`.

## MCP tools (each scopes to the token's userAddress)

- `create_agent_wallet(label?)` — mint a KMS key on demand (below), derive
  address, insert row, return `{ agentAddress, address }`.
- `list_agent_wallets()` — `SELECT ... WHERE owner_user_address = userAddress`.
- `get_agent_wallet()` — address + on-chain balance for the token's agent.
- `provision_wallet()` — build+broadcast `MsgProvision` for the token's agent.
- `sign_and_broadcast(intent)` — build `MsgWalletSpendAction` from structured
  intent for the token's agent, sign via KMS, broadcast over Agoric RPC.

## On-demand key/version creation (Q1)

Reuse the `docs/on-demand-wallets.md` sketch: factory
`createCryptoKey({ purpose: ASYMMETRIC_SIGN, versionTemplate: {
EC_SIGN_SECP256K1_SHA256, protectionLevel } })` (one key per agent) →
poll `getCryptoKeyVersion` with bounded backoff until `state === ENABLED` →
`getPublicKey` → `compressedPubkeyFromPem` → `addressFromCompressedPubkey`
→ insert row → return. Use a deterministic `cryptoKeyId` and dedupe on the
UNIQUE constraint so a client retry never mints an orphan key (KMS key material
can only be scheduled for destruction, never deleted). Mind KMS create/list quotas.

## IAM least-privilege (Q2 — default: ring-level)

- **Signing SA** (MCP service runtime, hot path): `roles/cloudkms.signerVerifier`
  only, scoped at the **key ring** (granted once by IaC). New keys inherit it, so
  the create path needs no runtime `setIamPolicy`. No admin, ever.
- **Factory identity** (create path): create-only
  (`cloudkms.cryptoKeys.create` + `cryptoKeyVersions.create` + `getPublicKey`),
  a custom role rather than broad `roles/cloudkms.admin`. Default placement: the
  MCP service **impersonates** a dedicated factory SA
  (`roles/iam.serviceAccountTokenCreator`) only for the create call, keeping
  admin off the always-on identity. (Alternative: a separate factory Cloud Run
  service — stronger isolation; flagged for design review.)

## Isolation (Q4 — confirmed decision 3: Model A)

Model A (application-layer authZ) is chosen; Model B is not designed for.
Cross-agent denial: extract `userAddress` + `agentAddress` from the verified
token → look up `agent_address` in Neon → if
`record.owner_user_address !== token.userAddress`, return **403 BEFORE**
resolving `keyVersion` or calling KMS. Defense-in-depth: clients cannot name
keys; the signer's built-in `signerAddress === address` assertion; Cloud Audit
Logs on KMS sign ops. **Model C (per-tenant key rings)** is documented as the
production hardening path (per-tenant ring + ring-scoped signerVerifier).

## Files to add (all under `services/mcp-agent-signer/`)

`package.json`, `tsconfig*.json`, `src/server.ts` (MCP + Streamable HTTP),
`src/tools.ts`, `src/auth.ts` (`getVerifiedAuth` seam), `src/store.ts` (Neon),
`src/factory.ts` (KMS create + poll), `src/signer/*` (vendored POC core),
`src/config.ts`, `test/*.test.ts`, `README.md`, IaC notes. No changes outside
this directory.

## Edge cases

- Version stuck `PENDING_GENERATION`: bounded backoff then error; row stays
  `pending`, retry idempotent via UNIQUE.
- Retry / duplicate create: deterministic id + UNIQUE → no orphan keys.
- Agent unfunded: fee check before provision/spend (as POC), clear error.
- Token agent-addr absent from store: 404 (not 403) — no ownership leak.
- Neon cold-start / pooler saturation: use pooled/serverless driver; fail fast.

## Test plan

- Unit (ava, no cloud): address derivation from a fixed PEM; store ownership
  check returns 403 before any KMS/keyVersion resolution (inject fake store);
  server-side `MsgWalletSpendAction` build from intent (owner bytes correct);
  auth seam rejects missing/omitted agent-addr; UNIQUE-violation → idempotent
  create. Inject fake KMS + fake `connectWithSigner` (as POC tests do).
- Manual: deploy to Cloud Run `--no-allow-unauthenticated`, exercise
  create→provision→spend against a testnet RPC.

## Out of scope

Funding wallets; key-**ring** creation (IaC/manual); the concrete authN/authZ
implementation (token verification is a black box — assume trusted
user+agent addr); modifying any agoric-sdk package or carrying anything to
upstream; key rotation, DR, multi-region (noted only).
