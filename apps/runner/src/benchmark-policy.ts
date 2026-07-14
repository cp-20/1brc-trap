const SLOW_FIRST_ATTEMPT_NS = 60_000_000_000n;

export function shouldStopAfterFirstAttempt(
  attempt: number,
  durationNs: string,
) {
  return attempt === 1 && BigInt(durationNs) > SLOW_FIRST_ATTEMPT_NS;
}
