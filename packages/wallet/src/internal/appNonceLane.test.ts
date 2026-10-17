/**
 * The SDK's own nonce lane: which nonce an app transaction is given, how two
 * of them sequence, and what happens when the account cannot be asked.
 *
 * Each test uses its own wallet address: the lane state is module state and
 * there is deliberately no reset hook.
 */
import { describe, expect, test } from "bun:test";
import type { Address, PublicClient } from "viem";
import {
  APP_LANE_SEQ_KEY,
  appLaneNonce,
  forgetAppLane,
  intendedAppLaneCounter,
  isAppLaneNonce,
  withAppLaneNonce,
} from "./appNonceLane.js";

const CELO = 11142220;
const BASE = 84532;
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

/** A public client whose `getNonce` answers `counter`, or throws when absent. */
function fakeClient(counter: bigint | "undelegated") {
  let reads = 0;
  const client = {
    async readContract() {
      reads += 1;
      if (counter === "undelegated") throw new Error("returned no data (0x)");
      // The account returns the whole next nonce, lane included.
      return appLaneNonce(counter);
    },
  } as unknown as PublicClient;
  return { client, reads: () => reads, set: (c: bigint) => (counter = c) };
}

describe("the app lane constant", () => {
  test("is non-zero, fits 192 bits, and is not the multichain prefix", () => {
    expect(APP_LANE_SEQ_KEY).toBeGreaterThan(0n);
    expect(APP_LANE_SEQ_KEY >> 192n).toBe(0n);
    // 0xc1d0 in the top 16 bits would make the account verify a digest with no
    // chain id in it, which is a different signing scheme, not a label.
    expect(APP_LANE_SEQ_KEY >> 176n).not.toBe(0xc1d0n);
    expect(appLaneNonce(0n) >> 240n).not.toBe(0xc1d0n);
  });

  test("a nonce on the lane is recognisable, and lane 0 is not on it", () => {
    expect(isAppLaneNonce(appLaneNonce(7n))).toBe(true);
    expect(appLaneNonce(7n) & ((1n << 64n) - 1n)).toBe(7n);
    expect(isAppLaneNonce(0n)).toBe(false);
    expect(isAppLaneNonce(3n)).toBe(false);
  });
});

describe("the nonce an app transaction is given", () => {
  test("is the account's own counter for the lane", async () => {
    const w = wallet(0x11);
    const { client } = fakeClient(5n);
    const seen: (bigint | undefined)[] = [];
    await withAppLaneNonce({ publicClient: client, wallet: w, chainId: CELO }, async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([appLaneNonce(5n)]);
  });

  test("is undefined when the account cannot be asked, so the relay chooses", async () => {
    // A fresh wallet: no delegation yet, the read reverts. The relay gives that
    // first intent a random sequence key, which collides with nothing.
    const w = wallet(0x12);
    const { client } = fakeClient("undelegated");
    const seen: (bigint | undefined)[] = [];
    await withAppLaneNonce({ publicClient: client, wallet: w, chainId: CELO }, async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([undefined]);
    expect(intendedAppLaneCounter(CELO, w)).toBeUndefined();
  });

  test("back-to-back transactions get consecutive counters", async () => {
    const w = wallet(0x13);
    // The chain does not advance between them: this is the read-after-write
    // case that makes the relay hand out the same nonce twice on lane 0.
    const { client } = fakeClient(0n);
    const seen: (bigint | undefined)[] = [];
    const body = async (n: bigint | undefined) => {
      seen.push(n);
    };
    await withAppLaneNonce({ publicClient: client, wallet: w, chainId: CELO }, body);
    await withAppLaneNonce({ publicClient: client, wallet: w, chainId: CELO }, body);
    await withAppLaneNonce({ publicClient: client, wallet: w, chainId: CELO }, body);
    expect(seen).toEqual([appLaneNonce(0n), appLaneNonce(1n), appLaneNonce(2n)]);
  });

  test("two fired at once sequence on the lane instead of sharing a nonce", async () => {
    const w = wallet(0x14);
    const { client } = fakeClient(0n);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstInFlight = new Promise<void>((r) => (releaseFirst = r));

    const first = withAppLaneNonce({ publicClient: client, wallet: w, chainId: CELO }, async (n) => {
      order.push(`first:${n! & ((1n << 64n) - 1n)}`);
      await firstInFlight;
      order.push("first:done");
    });
    const second = withAppLaneNonce({ publicClient: client, wallet: w, chainId: CELO }, async (n) => {
      order.push(`second:${n! & ((1n << 64n) - 1n)}`);
    });

    await new Promise((r) => setTimeout(r, 5));
    // The second has not been given a nonce yet: it is behind the first.
    expect(order).toEqual(["first:0"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:0", "first:done", "second:1"]);
  });

  test("a chain that has moved on wins over what this process believed", async () => {
    const w = wallet(0x15);
    const fake = fakeClient(0n);
    await withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO }, async () => {});
    expect(intendedAppLaneCounter(CELO, w)).toBe(1n);

    // Another process used the lane: the account is further along than we think.
    fake.set(9n);
    const seen: (bigint | undefined)[] = [];
    await withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO }, async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([appLaneNonce(9n)]);
  });

  test("a failed transaction drops the belief, so the next one re-reads", async () => {
    const w = wallet(0x16);
    const fake = fakeClient(4n);
    await expect(
      withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO }, async () => {
        throw new Error("InvalidNonce(InvalidNonce)");
      }),
    ).rejects.toThrow("InvalidNonce");
    expect(intendedAppLaneCounter(CELO, w)).toBeUndefined();

    // The chain never advanced, so the retry asks for the same counter again
    // rather than insisting on one the account already refused.
    const seen: (bigint | undefined)[] = [];
    await withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO }, async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([appLaneNonce(4n)]);
  });

  test("a failure does not wedge the lane for the transaction behind it", async () => {
    const w = wallet(0x17);
    const fake = fakeClient(0n);
    const failing = withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO }, async () => {
      throw new Error("relay down");
    });
    const after = withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO }, async (n) => n);
    await expect(failing).rejects.toThrow("relay down");
    expect(await after).toBe(appLaneNonce(0n));
  });

  test("the lane is per wallet and per chain", async () => {
    const a = wallet(0x18);
    const b = wallet(0x19);
    const fake = fakeClient(0n);
    const nonceFor = async (w: Address, chainId: number) =>
      withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId }, async (n) => n);

    expect(await nonceFor(a, CELO)).toBe(appLaneNonce(0n));
    expect(await nonceFor(a, CELO)).toBe(appLaneNonce(1n));
    // A different wallet, and a different chain, each start from the chain.
    expect(await nonceFor(b, CELO)).toBe(appLaneNonce(0n));
    expect(await nonceFor(a, BASE)).toBe(appLaneNonce(0n));
    // And the first pair is undisturbed.
    expect(await nonceFor(a, CELO)).toBe(appLaneNonce(2n));
  });

  test("forgetting a lane makes the next read authoritative", async () => {
    const w = wallet(0x1a);
    const fake = fakeClient(0n);
    await withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO }, async () => {});
    expect(intendedAppLaneCounter(CELO, w)).toBe(1n);
    forgetAppLane(CELO, w);
    expect(intendedAppLaneCounter(CELO, w)).toBeUndefined();
    expect(
      await withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO }, async (n) => n),
    ).toBe(appLaneNonce(0n));
  });
});
