/**
 * A nonce lane of the SDK's own, so an app's transactions never contend with
 * the relay's.
 *
 * `IthacaAccount` counts nonces per sequence key: the upper 192 bits of a
 * nonce are the `seqKey` and the lower 64 a counter for that key alone
 * (`IthacaAccount.sol`, "4337-style 2D nonce sequences"). Intents in different
 * lanes never contend.
 *
 * Everything used to share lane 0. Measured from the Orchestrator's
 * `IntentExecuted` on 2026-10-17: a background KeyStore registration's two
 * funding intents took lane-0 counters 0 and 1 and an app's `execute` took a
 * counter in between them. The relay reserves no nonce for an intent it has not
 * mined, so any overlap in preparation gives two intents the same nonce and one
 * fails `InvalidNonce`
 * (`evidence/2026-10-17-nonce-lanes.md`).
 *
 * The registration's funding intent cannot be moved from the client: the relay
 * builds it itself with `nonce: None` hardcoded. So the SDK moves what it does
 * own -- the app's transactions -- and leaves lane 0 to the relay.
 */

import type { Address, PublicClient } from "viem";

/**
 * The lane every app transaction the SDK prepares runs on.
 *
 * Two hard requirements and one soft one:
 *  - **not 0**, which is the relay's lane;
 *  - **not `0xc1d0`-prefixed**: the account reads that prefix as "this intent
 *    is multichain" and verifies a digest with the chain id left out
 *    (`IthacaAccount.sol`, `Orchestrator.sol`). A lane is not a free label.
 *  - recognisable in an explorer, hence the readable constant rather than a
 *    hash: a nonce on this lane starts `0xa17a…`, and the trailing `1` leaves
 *    room for another lane later without disturbing this one's counter.
 */
export const APP_LANE_SEQ_KEY: bigint = (0xa17an << 176n) | 1n;

/** The full 256-bit nonce for `counter` on the app lane. */
export function appLaneNonce(counter: bigint): bigint {
  return (APP_LANE_SEQ_KEY << 64n) | counter;
}

/** Whether a nonce is on the app lane. For tests and diagnostics. */
export function isAppLaneNonce(nonce: bigint): boolean {
  return nonce >> 64n === APP_LANE_SEQ_KEY;
}

const GET_NONCE_ABI = [
  {
    name: "getNonce",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "seqKey", type: "uint192" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** chain:wallet -> the next counter this process intends to use. */
const intended = new Map<string, bigint>();
/** chain:wallet -> the tail of the queue of intents on this lane. */
const queue = new Map<string, Promise<unknown>>();

const laneKey = (chainId: number, wallet: Address) => `${chainId}:${wallet.toLowerCase()}`;

/** Forgets what this process believed, so the next read comes from the chain. */
export function forgetAppLane(chainId: number, wallet: Address): void {
  intended.delete(laneKey(chainId, wallet));
}

/** What this process currently believes the next counter is. Tests only. */
export function intendedAppLaneCounter(chainId: number, wallet: Address): bigint | undefined {
  return intended.get(laneKey(chainId, wallet));
}

/**
 * The account's counter for the app lane, or undefined when the account cannot
 * answer.
 *
 * Undefined is the **fresh wallet** case and it matters: before the delegation
 * lands there is no account to ask, the read reverts, and an intent must not
 * carry a lane at all. The relay gives that first intent a random sequence key
 * of its own (`Account::random_nonce`), which collides with nothing, and from
 * the next intent on this read works.
 */
async function onChainCounter(
  publicClient: PublicClient,
  wallet: Address,
): Promise<bigint | undefined> {
  try {
    const next = (await publicClient.readContract({
      address: wallet,
      abi: GET_NONCE_ABI,
      functionName: "getNonce",
      args: [APP_LANE_SEQ_KEY],
    })) as bigint;
    // The account returns the whole next nonce, lane included.
    return next & ((1n << 64n) - 1n);
  } catch {
    return undefined;
  }
}

/**
 * Runs `send` with the nonce it should use on the app lane, one intent at a
 * time per wallet and chain.
 *
 * Why it queues: a lane's counter is strictly sequential, so counter N+1 cannot
 * execute before N. Handing out N and N+1 concurrently would not avoid a
 * collision, it would move it. Each intent therefore waits for the one before
 * it on the same lane. That is a wait between the caller's OWN back-to-back
 * transactions, which were always going to be ordered; it is not a wait on the
 * relay's background work, which is the thing that must never block an app.
 *
 * `send` is given `undefined` when the account cannot be asked for a counter
 * (an undelegated wallet), meaning "send this without a nonce of ours".
 *
 * On `InvalidNonce` this process's belief is dropped, so the retry re-reads the
 * chain rather than insisting on a number the account has already refused.
 */
export async function withAppLaneNonce<T>(
  args: { publicClient: PublicClient; wallet: Address; chainId: number },
  send: (nonce: bigint | undefined) => Promise<T>,
): Promise<T> {
  const key = laneKey(args.chainId, args.wallet);
  const previous = queue.get(key);

  const run = (async (): Promise<T> => {
    // Wait for the intent before this one on this lane, however it ended.
    if (previous) await previous.catch(() => undefined);

    const chainCounter = await onChainCounter(args.publicClient, args.wallet);
    if (chainCounter === undefined) {
      // Undelegated: no lane, let the relay choose.
      forgetAppLane(args.chainId, args.wallet);
      return await send(undefined);
    }

    // The chain is the authority; this process's belief only ever runs ahead of
    // it, for an intent of ours that has not been mined yet.
    const believed = intended.get(key);
    const counter = believed !== undefined && believed > chainCounter ? believed : chainCounter;

    try {
      const result = await send(appLaneNonce(counter));
      intended.set(key, counter + 1n);
      return result;
    } catch (err) {
      forgetAppLane(args.chainId, args.wallet);
      throw err;
    }
  })();

  queue.set(key, run);
  void run.catch(() => undefined).then(() => {
    if (queue.get(key) === run) queue.delete(key);
  });
  return run;
}
