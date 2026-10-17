/**
 * Holds on a (chain, wallet) pair while this SDK has an intent of its own in
 * flight there, so a second intent is not prepared against the same nonce.
 *
 * The relay reserves no nonce for an intent it has not mined: it echoes the
 * account's on-chain nonce to every `wallet_prepareCalls`, so two intents
 * prepared for one wallet before the first lands both get that nonce and the
 * second fails `InvalidNonce`
 * (`evidence/2026-09-28-back-to-back-race-attribution.md`).
 *
 * `grantSession` already sequences its own legs. What it cannot sequence is the
 * caller: a background KeyStore registration pays for the L1 write with an
 * intent from the wallet's account on the L2, and an app that executes while
 * that is in flight collides with it. This is the wait that stops it — per
 * wallet and chain, only for the length of the window, and nothing to do with
 * any other wallet or chain.
 *
 * In-process only. It is not a distributed lock and does not pretend to be
 * one: two processes acting for one wallet on one chain can still collide, and
 * that needs client-supplied nonces (`capabilities.meta.nonce`), which is its
 * own piece of work.
 */

import type { Address } from "viem";

/** chain:wallet -> resolves when nothing this SDK started is in flight there. */
const holds = new Map<string, Promise<void>>();

const holdKey = (chainId: number, wallet: Address) => `${chainId}:${wallet.toLowerCase()}`;

/**
 * How long a hold can delay an execute before it goes anyway.
 *
 * A hold is released when the work it waits on settles, and the work always
 * settles, so this is not the normal exit. It is here because a wait that can
 * outlive its reason is worse than a nonce collision: the collision is one
 * failed intent with a clear error, an unbounded wait is an app that never
 * does anything again.
 */
export const PENDING_INTENT_HOLD_CAP_MS = 180_000;

/**
 * Hold (chainId, wallet) until `until` settles — fulfilled or rejected, since
 * a failure means there is nothing left in flight to collide with.
 *
 * Concurrent holds compose: the pair is held until all of them are done.
 */
export function holdPendingIntent(
  chainId: number,
  wallet: Address,
  until: Promise<unknown>,
  capMs: number = PENDING_INTENT_HOLD_CAP_MS,
): void {
  const key = holdKey(chainId, wallet);
  const settled = settleOrCap(until, capMs);
  const previous = holds.get(key);
  const combined = previous
    ? Promise.all([previous, settled]).then(() => undefined)
    : settled;
  holds.set(key, combined);
  void combined.then(() => {
    // Only clear our own entry: a later hold may have replaced it.
    if (holds.get(key) === combined) holds.delete(key);
  });
}

/**
 * Resolves once nothing this SDK started is in flight for (chainId, wallet).
 * Resolves immediately when there is no hold, which is the ordinary case.
 */
export function awaitPendingIntents(chainId: number, wallet: Address): Promise<void> {
  return holds.get(holdKey(chainId, wallet)) ?? Promise.resolve();
}

/** True while (chainId, wallet) is held. For tests and diagnostics. */
export function isPendingIntentHeld(chainId: number, wallet: Address): boolean {
  return holds.has(holdKey(chainId, wallet));
}

/** Settles when `until` does, or when the cap elapses, whichever is first. */
function settleOrCap(until: Promise<unknown>, capMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, capMs);
    // Never keep the process alive for a hold nobody is waiting on.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  const done = until.then(
    () => undefined,
    () => undefined,
  );
  return Promise.race([done, capped]).then(() => {
    if (timer) clearTimeout(timer);
  });
}
