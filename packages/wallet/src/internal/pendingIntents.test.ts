/**
 * The wait that keeps a caller's intent off a nonce this SDK is already using.
 *
 * Each test uses its own wallet address, because the holds are module state
 * and there is deliberately no reset hook to call.
 */
import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import {
  awaitPendingIntents,
  holdPendingIntent,
  isPendingIntentHeld,
} from "./pendingIntents.js";

const CELO = 11142220;
const SEPOLIA = 11155111;
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

/** Whether a promise is still unresolved right now. */
const PENDING = Symbol("pending");
async function stillWaiting(p: Promise<unknown>): Promise<boolean> {
  return (await Promise.race([p, Promise.resolve(PENDING)])) === PENDING;
}
const tick = () => new Promise((r) => setTimeout(r, 1));

describe("a hold while this SDK has an intent in flight", () => {
  test("an execute in the window waits, and goes once the intent is mined", async () => {
    const w = wallet(1);
    let mined!: () => void;
    const inFlight = new Promise<void>((r) => {
      mined = r;
    });
    holdPendingIntent(CELO, w, inFlight);

    const waiting = awaitPendingIntents(CELO, w);
    expect(await stillWaiting(waiting)).toBe(true);
    expect(isPendingIntentHeld(CELO, w)).toBe(true);

    mined();
    await waiting;
    expect(await stillWaiting(waiting)).toBe(false);
  });

  test("an execute outside the window is immediate", async () => {
    // Never held at all.
    expect(await stillWaiting(awaitPendingIntents(CELO, wallet(2)))).toBe(false);

    // Held, then released.
    const w = wallet(3);
    let mined!: () => void;
    holdPendingIntent(CELO, w, new Promise<void>((r) => (mined = r)));
    mined();
    await awaitPendingIntents(CELO, w);
    expect(await stillWaiting(awaitPendingIntents(CELO, w))).toBe(false);
    expect(isPendingIntentHeld(CELO, w)).toBe(false);
  });

  test("a failed intent releases the wait instead of blocking forever", async () => {
    const w = wallet(4);
    let failed!: (e: Error) => void;
    const inFlight = new Promise<void>((_, reject) => {
      failed = reject;
    });
    holdPendingIntent(CELO, w, inFlight);
    const waiting = awaitPendingIntents(CELO, w);
    expect(await stillWaiting(waiting)).toBe(true);

    failed(new Error("the relay rejected the request"));
    // Resolves, and does not reject onto the caller's execute.
    await waiting;
    expect(await stillWaiting(waiting)).toBe(false);
  });

  test("a registration that resolves FAILED releases it too", async () => {
    // The real shape: the write never rejects, it resolves to a failed outcome.
    const w = wallet(5);
    let settle!: (v: unknown) => void;
    holdPendingIntent(CELO, w, new Promise((r) => (settle = r)));
    const waiting = awaitPendingIntents(CELO, w);
    expect(await stillWaiting(waiting)).toBe(true);

    settle({ status: "FAILED", reason: "quote has asset deficits" });
    await waiting;
    expect(await stillWaiting(waiting)).toBe(false);
  });

  test("the hold is per chain and per wallet, and leaves the others alone", async () => {
    const held = wallet(6);
    const other = wallet(7);
    let mined!: () => void;
    holdPendingIntent(CELO, held, new Promise<void>((r) => (mined = r)));

    expect(await stillWaiting(awaitPendingIntents(CELO, held))).toBe(true);
    // Same wallet, different chain.
    expect(await stillWaiting(awaitPendingIntents(SEPOLIA, held))).toBe(false);
    // Same chain, different wallet.
    expect(await stillWaiting(awaitPendingIntents(CELO, other))).toBe(false);

    mined();
    await awaitPendingIntents(CELO, held);
  });

  test("the wallet address is matched without regard to case", async () => {
    const lower = "0x00000000000000000000000000000000000000aa" as Address;
    const upper = "0x00000000000000000000000000000000000000AA" as Address;
    let mined!: () => void;
    holdPendingIntent(CELO, lower, new Promise<void>((r) => (mined = r)));
    expect(await stillWaiting(awaitPendingIntents(CELO, upper))).toBe(true);
    mined();
    await awaitPendingIntents(CELO, upper);
  });

  test("two holds on one pair both have to finish", async () => {
    const w = wallet(8);
    let first!: () => void;
    let second!: () => void;
    holdPendingIntent(CELO, w, new Promise<void>((r) => (first = r)));
    holdPendingIntent(CELO, w, new Promise<void>((r) => (second = r)));

    const waiting = awaitPendingIntents(CELO, w);
    first();
    await tick();
    expect(await stillWaiting(waiting)).toBe(true);

    second();
    await waiting;
    expect(isPendingIntentHeld(CELO, w)).toBe(false);
  });

  test("the cap releases a hold whose work never settles", async () => {
    const w = wallet(9);
    // Never settles: a relay that answers nothing must not wedge the caller.
    holdPendingIntent(CELO, w, new Promise(() => {}), 20);
    const waiting = awaitPendingIntents(CELO, w);
    expect(await stillWaiting(waiting)).toBe(true);
    await waiting;
    expect(isPendingIntentHeld(CELO, w)).toBe(false);
  });
});
