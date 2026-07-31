export {
  describeCapability,
  isUsable,
  type CapabilityRegistry,
  type CapabilityStatus,
} from './capability.js';

export {
  A1MOBILE_CAPABILITIES,
  type A1MobileAdapter,
  type A1MobileCapability,
  type A1MobilePayload,
  type Authorization,
  type CallEndReason,
  type CommandContext,
  type CommandFailure,
  type CommandResult,
  type DeliveryContext,
  type GatherInput,
  type RawWebhookDelivery,
  type SendSmsInput,
  type SmsDeliveryStatus,
  type SpeakInput,
  type TransferInput,
  type VerificationFailure,
  type VerificationResult,
  type VerifiedInboundEvent,
} from './a1mobile/contract.js';

export { createA1MobileProductionAdapter } from './a1mobile/production.js';
export {
  createA1MobileSimulator,
  type A1MobileSimulator,
  type RecordedCommand,
  type SimulatorOptions,
} from './a1mobile/simulator.js';
