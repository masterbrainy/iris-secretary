/**
 * Exhaustiveness guard for discriminated unions.
 *
 * The compiler rejects any call where `value` is still inhabited, so adding a
 * conversation state or founder action without handling it becomes a type
 * error at build time rather than a silent fallthrough at runtime. The throw
 * only fires if something upstream lied about its type at a boundary.
 */
export function assertNever(value: never, context?: string): never {
  const shown = JSON.stringify(value);
  throw new Error(
    context === undefined ? `Unhandled case: ${shown}` : `Unhandled case in ${context}: ${shown}`,
  );
}
