/**
 * Cloud Run (gen2) function entrypoint for the kms-signer-poc.
 *
 * This is the deployable proof that exercises the vendored KMS signer
 * (`./kms-direct-signer.ts`). It has no Dockerfile: Cloud Run functions build
 * the source with buildpacks. Deploy with a dedicated service-account granted
 * `roles/cloudkms.signerVerifier` on the key; `@google-cloud/kms` picks up ADC
 * from the metadata server, so no key files or mounted secrets are needed.
 *
 * See designs/kms-backed-agoric-signing.md ("POC runbook").
 */
import * as functions from '@google-cloud/functions-framework';
import { fromBech32 } from '@cosmjs/encoding';

import type { StdFee } from '@cosmjs/stargate';

import { loadConfig } from './config.ts';
import {
  AGORIC_WALLET_SPEND_ACTION_TYPE_URL,
  makeKmsDirectSigner,
  makeStargateClientKitFromKms,
} from './kms-direct-signer.ts';

/**
 * A reasonable default fee for a single WalletSpendAction, mirroring the
 * `client-utils` default (0.01 BLD at the recommended min gas price).
 */
const defaultFee: StdFee = {
  gas: '400000',
  amount: [{ denom: 'ubld', amount: '10000' }],
};

/**
 * HTTP handler `sign`.
 *
 * - Always derives and returns the `agoric1…` address from the KMS public key
 *   (one `getPublicKey` round-trip, no broadcast).
 * - When `RPC` is configured and the request body carries a `spendAction`,
 *   signs and broadcasts a `MsgWalletSpendAction` via the KMS signer and
 *   returns the delivery result. This is the end-to-end proof.
 */
functions.http('sign', async (req: functions.Request, res: functions.Response) => {
  try {
    const config = loadConfig(process.env);
    const { keyVersionName, prefix, rpcAddr } = config;

    const spendAction: string | undefined = req.body?.spendAction;

    if (!spendAction) {
      // eslint-disable-next-line @jessie.js/safe-await-separator -- POC handler
      const signer = await makeKmsDirectSigner({ keyVersionName, prefix });
      const [{ address, pubkey }] = await signer.getAccounts();
      res.status(200).json({
        address,
        pubkey: Buffer.from(pubkey).toString('base64'),
      });
      return;
    }

    if (!rpcAddr) {
      res
        .status(400)
        .json({ error: 'RPC must be configured to broadcast a spendAction' });
      return;
    }

    const { address, client } = await makeStargateClientKitFromKms({
      keyVersionName,
      prefix,
      rpcAddr,
    });

    const { MsgWalletSpendAction } = await import(
      '@agoric/cosmic-proto/agoric/swingset/msgs.js'
    );
    const value = MsgWalletSpendAction.fromPartial({
      owner: fromBech32(address).data,
      spendAction,
    });
    const result = await client.signAndBroadcast(
      address,
      [{ typeUrl: AGORIC_WALLET_SPEND_ACTION_TYPE_URL, value }],
      defaultFee,
    );

    res.status(200).json({
      address,
      transactionHash: result.transactionHash,
      code: result.code,
      height: result.height,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
