import { describe, expect, it } from 'vitest';
import { createEnvelope, decideIngest, deriveSideEffectKey } from '@cynthia/domain';
import { createA1MobileSimulator } from './simulator.js';
import { createA1MobileProductionAdapter } from './production.js';
import { A1MOBILE_CAPABILITIES, type CommandContext } from './contract.js';

const CTX: CommandContext = {
  idempotencyKey: 'key-1',
  timeoutMs: 5_000,
  authorization: { grantedBy: 'policy', reference: 'decision-1' },
};

function delivery(traceId = 'trace-1', receivedAt = '2026-07-31T10:00:00.000Z') {
  return { traceId, receivedAt };
}

describe('every capability is pending — nothing here is a live integration', () => {
  it('marks all a1mobile capabilities pending', () => {
    for (const [name, status] of Object.entries(A1MOBILE_CAPABILITIES)) {
      expect(status, `${name} must not claim to be live`).toBe('pending');
    }
  });

  it('has the production adapter refuse every command with a typed failure', async () => {
    const adapter = createA1MobileProductionAdapter();

    const results = await Promise.all([
      adapter.answerCall('c1', CTX),
      adapter.speak({ callId: 'c1', text: 'hello' }, CTX),
      adapter.hold('c1', CTX),
      adapter.transferCall({ callId: 'c1', to: '+1555', mode: 'warm' }, CTX),
      adapter.terminateCall('c1', 'completed', CTX),
      adapter.sendSms({ to: '+1555', from: '+1666', body: 'hi' }, CTX),
    ]);

    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe('capability-pending');
    }
  });

  it('refuses to verify a webhook rather than trusting an unsigned one', () => {
    const adapter = createA1MobileProductionAdapter();
    const result = adapter.verifyAndParse(
      {
        body: '{}',
        headers: {},
        rawEventRef: { storageKey: 'k', contentHash: 'h', byteLength: 2 },
      },
      delivery(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('capability-pending');
  });

  it('never throws — a refusal the orchestrator can handle beats an exception', async () => {
    const adapter = createA1MobileProductionAdapter();
    await expect(adapter.sendSms({ to: 'x', from: 'y', body: 'z' }, CTX)).resolves.toBeDefined();
  });
});

describe('the simulator feeds the real pipeline rather than bypassing it', () => {
  it('produces a signed delivery that verifies and yields a usable envelope', () => {
    const sim = createA1MobileSimulator();
    const raw = sim.incomingCall({ from: '+15550001', to: '+15559999' });

    const verified = sim.verifyAndParse(raw, delivery());
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    expect(verified.event.payload.kind).toBe('call.incoming');

    const envelope = createEnvelope(verified.event.envelope);
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      expect(envelope.envelope.provider).toBe('a1mobile');
      expect(envelope.envelope.idempotencyKey).toContain('a1mobile:');
    }
  });

  it('rejects a tampered body, so verification is genuinely exercised', () => {
    const sim = createA1MobileSimulator();
    const raw = sim.incomingCall({ from: '+15550001', to: '+15559999' });
    const tampered = { ...raw, body: raw.body.replace('+15550001', '+19995555') };

    const result = sim.verifyAndParse(tampered, delivery());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('bad-signature');
  });

  it('emits every event kind the orchestrator has to handle', () => {
    const sim = createA1MobileSimulator();
    const call = sim.incomingCall({ from: '+1', to: '+2' });
    const callId = sim.knownCalls()[0]!;

    const kinds = [
      call,
      sim.callAnswered(callId),
      sim.callerSaid({ callId, text: 'what are your hours?' }),
      sim.recordingReady(callId, 'rec-1'),
      sim.callEnded(callId, 'caller-hung-up'),
      sim.inboundSms({ from: '+1', to: '+2', body: 'hello' }),
      sim.smsStatus('sim-msg-1', 'delivered'),
    ].map((raw) => {
      const verified = sim.verifyAndParse(raw, delivery());
      return verified.ok ? verified.event.payload.kind : 'FAILED';
    });

    expect(kinds).toEqual([
      'call.incoming',
      'call.answered',
      'transcript.segment',
      'recording.ready',
      'call.ended',
      'sms.inbound',
      'sms.status',
    ]);
  });

  it('carries transcription confidence through, which the policy gate needs', () => {
    const sim = createA1MobileSimulator();
    sim.incomingCall({ from: '+1', to: '+2' });
    const callId = sim.knownCalls()[0]!;

    const raw = sim.callerSaid({ callId, text: 'four thousand', confidence: 0.32 });
    const verified = sim.verifyAndParse(raw, delivery());

    expect(verified.ok).toBe(true);
    if (verified.ok && verified.event.payload.kind === 'transcript.segment') {
      expect(verified.event.payload.confidence).toBe(0.32);
    }
  });
});

describe('duplicate delivery', () => {
  it('produces the same idempotency key on redelivery, so the domain skips it', () => {
    const sim = createA1MobileSimulator();
    const raw = sim.incomingCall({ from: '+1', to: '+2' });

    const first = sim.verifyAndParse(raw, delivery('trace-1', '2026-07-31T10:00:00.000Z'));
    const again = sim.verifyAndParse(
      sim.redeliver(raw),
      delivery('trace-2', '2026-07-31T10:00:09.000Z'),
    );

    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;

    const a = createEnvelope(first.event.envelope);
    const b = createEnvelope(again.event.envelope);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(b.envelope.idempotencyKey).toBe(a.envelope.idempotencyKey);

    const decision = decideIngest(b.envelope, {
      priorDelivery: {
        idempotencyKey: a.envelope.idempotencyKey,
        traceId: a.envelope.traceId,
        receivedAt: a.envelope.receivedAt,
      },
      highWaterMark: undefined,
    });

    expect(decision.kind).toBe('skip');
  });

  it('does not send a second SMS when the same command is retried', async () => {
    const sim = createA1MobileSimulator();
    const raw = sim.inboundSms({ from: '+1', to: '+2', body: 'hello' });
    const verified = sim.verifyAndParse(raw, delivery());
    if (!verified.ok) throw new Error('expected verification to succeed');
    const envelope = createEnvelope(verified.event.envelope);
    if (!envelope.ok) throw new Error('expected a valid envelope');

    const key = deriveSideEffectKey(envelope.envelope.idempotencyKey, 'send-sms');
    const context: CommandContext = { ...CTX, idempotencyKey: key };

    const first = await sim.sendSms({ to: '+1', from: '+2', body: 'we are open until 5' }, context);
    const retry = await sim.sendSms({ to: '+1', from: '+2', body: 'we are open until 5' }, context);

    expect(first.ok && !first.deduplicated).toBe(true);
    expect(retry.ok && retry.deduplicated).toBe(true);
    expect(sim.commands.filter((c) => c.kind === 'sms.send')).toHaveLength(1);
  });

  it('returns the original value on a deduplicated retry', async () => {
    const sim = createA1MobileSimulator();
    const first = await sim.sendSms({ to: '+1', from: '+2', body: 'x' }, CTX);
    const retry = await sim.sendSms({ to: '+1', from: '+2', body: 'x' }, CTX);

    expect(first.ok && retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.value.providerMessageId).toBe(first.value.providerMessageId);
    }
  });
});

describe('out-of-order delivery', () => {
  it('stamps increasing sequence numbers that survive reordering', () => {
    const sim = createA1MobileSimulator();
    const call = sim.incomingCall({ from: '+1', to: '+2' });
    const callId = sim.knownCalls()[0]!;
    const answered = sim.callAnswered(callId);
    const ended = sim.callEnded(callId, 'caller-hung-up');

    // Feed them backwards, as a provider retry storm might.
    const sequences = [ended, answered, call].map((raw) => {
      const verified = sim.verifyAndParse(raw, delivery());
      return verified.ok ? verified.event.envelope.sequence : -1;
    });

    expect(sequences).toEqual([3, 2, 1]);
  });

  it('lets the domain flag a late event without dropping it', () => {
    const sim = createA1MobileSimulator();
    const first = sim.incomingCall({ from: '+1', to: '+2' });
    const callId = sim.knownCalls()[0]!;
    const later = sim.callAnswered(callId);

    const lateVerified = sim.verifyAndParse(first, delivery());
    const laterVerified = sim.verifyAndParse(later, delivery());
    if (!lateVerified.ok || !laterVerified.ok) throw new Error('expected verification');

    const lateEnvelope = createEnvelope(lateVerified.event.envelope);
    if (!lateEnvelope.ok) throw new Error('expected a valid envelope');

    const decision = decideIngest(lateEnvelope.envelope, {
      priorDelivery: undefined,
      highWaterMark: 2,
    });

    expect(decision.kind).toBe('process');
    if (decision.kind === 'process') expect(decision.outOfOrder).toBe(true);
  });
});

describe('provider outage', () => {
  it('fails every command with a retryable outage while down', async () => {
    const sim = createA1MobileSimulator();
    sim.incomingCall({ from: '+1', to: '+2' });
    const callId = sim.knownCalls()[0]!;

    sim.setOutage(true);
    const result = await sim.speak({ callId, text: 'one moment' }, CTX);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('provider-outage');
      if (result.failure.kind === 'provider-outage') expect(result.failure.retryable).toBe(true);
    }
  });

  it('records no side effect for a command that failed during an outage', async () => {
    const sim = createA1MobileSimulator();
    sim.setOutage(true);
    await sim.sendSms({ to: '+1', from: '+2', body: 'x' }, CTX);

    expect(sim.commands).toHaveLength(0);
  });

  it('recovers when the outage clears', async () => {
    const sim = createA1MobileSimulator();
    sim.setOutage(true);
    await sim.sendSms({ to: '+1', from: '+2', body: 'x' }, CTX);
    sim.setOutage(false);

    const result = await sim.sendSms({ to: '+1', from: '+2', body: 'x' }, CTX);
    expect(result.ok).toBe(true);
  });
});

describe('command safety', () => {
  it('refuses to act on a call it does not know about', async () => {
    const sim = createA1MobileSimulator();
    const result = await sim.hold('no-such-call', CTX);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('unknown-call');
  });

  it('records who authorised every side effect', async () => {
    const sim = createA1MobileSimulator();
    await sim.sendSms(
      { to: '+1', from: '+2', body: 'x' },
      { ...CTX, authorization: { grantedBy: 'founder', reference: 'esc-7' } },
    );

    expect(sim.commands[0]?.authorizedBy).toBe('founder:esc-7');
  });
});

describe('determinism', () => {
  it('produces byte-identical output for the same script', () => {
    function script() {
      const sim = createA1MobileSimulator({ startAt: '2026-07-31T10:00:00.000Z' });
      const a = sim.incomingCall({ from: '+1', to: '+2' });
      sim.advance(1_000);
      const callId = sim.knownCalls()[0]!;
      const b = sim.callerSaid({ callId, text: 'hello' });
      return [a.body, b.body];
    }

    expect(script()).toEqual(script());
  });

  it('moves time only when told to', () => {
    const sim = createA1MobileSimulator({ startAt: '2026-07-31T10:00:00.000Z' });
    expect(sim.now()).toBe('2026-07-31T10:00:00.000Z');

    sim.advance(45_000);
    expect(sim.now()).toBe('2026-07-31T10:00:45.000Z');
  });
});
