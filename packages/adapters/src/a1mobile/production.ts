/**
 * The production a1mobile adapter.
 *
 * It implements the full contract and refuses every operation with a typed
 * `capability-pending` failure, because **a1mobile publishes no developer
 * API** (docs/architecture.md §2). That is the honest implementation, not a
 * placeholder: CLAUDE.md says to preserve the integration contract, mark the
 * capability pending, and back it with a simulator — never to fake the
 * feature.
 *
 * It deliberately does not throw. A thrown "not implemented" would surface as
 * an unhandled failure somewhere unpredictable; a typed refusal makes the
 * orchestrator handle it, which is how the client ends up hearing an honest
 * deferral instead of silence.
 *
 * When credentials and real documentation arrive, the pending returns get
 * replaced one capability at a time and `A1MOBILE_CAPABILITIES` flips to
 * `live` per capability — the contract above it does not change.
 */

import {
  A1MOBILE_CAPABILITIES,
  type A1MobileAdapter,
  type A1MobileCapability,
  type CallEndReason,
  type CommandContext,
  type CommandAck,
  type CommandResult,
  type DeliveryContext,
  type GatherInput,
  type RawWebhookDelivery,
  type SendSmsInput,
  type SentSms,
  type SpeakInput,
  type TransferInput,
  type VerificationResult,
} from './contract.js';

const PENDING_NOTE =
  'a1mobile publishes no developer API and no credentials are configured, so this capability is pending. A simulator stands in for local development and tests.';

function pending<T>(capability: A1MobileCapability): CommandResult<T> {
  return {
    ok: false,
    failure: { kind: 'capability-pending', capability, message: PENDING_NOTE },
  };
}

export function createA1MobileProductionAdapter(): A1MobileAdapter {
  return {
    capabilities: A1MOBILE_CAPABILITIES,

    verifyAndParse(_delivery: RawWebhookDelivery, _context: DeliveryContext): VerificationResult {
      // Refusing to parse is the safe failure. Accepting an unverified webhook
      // because we have no signing scheme documented would mean acting on
      // anything that reached the endpoint.
      return {
        ok: false,
        failure: {
          kind: 'capability-pending',
          capability: 'webhook.verify',
          message: `${PENDING_NOTE} The webhook signing scheme is undocumented, so no delivery can be verified.`,
        },
      };
    },

    answerCall(_callId: string, _context: CommandContext) {
      return Promise.resolve(pending<CommandAck>('call.answer'));
    },
    speak(_input: SpeakInput, _context: CommandContext) {
      return Promise.resolve(pending<CommandAck>('call.speak'));
    },
    gather(_input: GatherInput, _context: CommandContext) {
      return Promise.resolve(pending<CommandAck>('call.gather'));
    },
    hold(_callId: string, _context: CommandContext) {
      return Promise.resolve(pending<CommandAck>('call.hold'));
    },
    resume(_callId: string, _context: CommandContext) {
      return Promise.resolve(pending<CommandAck>('call.hold'));
    },
    transferCall(_input: TransferInput, _context: CommandContext) {
      return Promise.resolve(pending<CommandAck>('call.transfer'));
    },
    terminateCall(_callId: string, _reason: CallEndReason, _context: CommandContext) {
      return Promise.resolve(pending<CommandAck>('call.terminate'));
    },
    sendSms(_input: SendSmsInput, _context: CommandContext) {
      return Promise.resolve(pending<SentSms>('sms.send'));
    },
  };
}
