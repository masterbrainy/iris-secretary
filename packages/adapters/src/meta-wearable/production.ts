/**
 * The production Meta wearable adapter.
 *
 * Every operation refuses, because the glasses path is unavailable on three
 * independent counts (docs/meta-wearable-spike.md):
 *
 *  - No Meta developer account, Application ID, or approved permission
 *    justification exists, and no Ray-Ban Meta hardware is available (§6).
 *  - The Device Access Toolkit exposes **no audio API at all** and **no
 *    server-side API**, so the server cannot reach the glasses directly (§1.1).
 *  - The companion app that would bridge the gap does not exist yet, and on
 *    iOS cannot currently be published at all (§1.4).
 *
 * Refusing with a typed reason rather than throwing is what lets the
 * orchestrator degrade to the next rung of the fallback ladder — and, if every
 * rung refuses, give the client an honest deferral instead of silence.
 */

import {
  META_WEARABLE_CAPABILITIES,
  type AdapterHealth,
  type DeliveryOptions,
  type DeliveryOutcome,
  type FounderChannel,
  type FounderResponseEvent,
  type MetaWearableAdapter,
  type Unsubscribe,
  type WearablePrompt,
} from './contract.js';

const PENDING_DETAIL =
  'The Meta Wearables Device Access Toolkit exposes no server-side API, and no developer account, companion app, or hardware is configured. A simulator stands in for local development and tests.';

export function createMetaWearableProductionAdapter(): MetaWearableAdapter {
  const channel: FounderChannel = 'glasses';

  return {
    channel,
    capabilities: META_WEARABLE_CAPABILITIES,

    deliverPrompt(_prompt: WearablePrompt, _options: DeliveryOptions): Promise<DeliveryOutcome> {
      return Promise.resolve({
        status: 'undeliverable',
        channel,
        reason: 'capability-pending',
        detail: PENDING_DETAIL,
      });
    },

    cancelPrompt(_escalationId: string, _reason: string): Promise<void> {
      // Nothing was ever delivered, so there is nothing to withdraw. Succeeding
      // quietly is right here: cancellation is best-effort by contract, and
      // failing it would give a caller a problem it cannot act on.
      return Promise.resolve();
    },

    onFounderResponse(_handler: (event: FounderResponseEvent) => void): Unsubscribe {
      // No transport exists, so no response can ever arrive. The subscription
      // is accepted so callers need no special case, and simply never fires.
      return () => undefined;
    },

    health(): Promise<AdapterHealth> {
      return Promise.resolve({ reachable: false, detail: PENDING_DETAIL });
    },
  };
}
