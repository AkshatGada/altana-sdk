/**
 * What `execute` actually puts on the wire: `capabilities.meta.nonce` carrying
 * the SDK's own lane, over a mocked fetch that plays both the relay and the
 * public RPC.
 *
 * The lane module's own tests cover its arithmetic. These cover the part a
 * reader cannot check from them: that the nonce reaches the relay, that two
 * back-to-back transactions carry consecutive counters, and that a wallet which
 * is not delegated yet sends no nonce at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { numberToHex, type Address, type Hex } from "viem";
import { CELO_SEPOLIA } from "./config.js";
import { createPrivateKeySigner } from "./internal/signer.js";
import { execute } from "./execute.js";
import { APP_LANE_SEQ_KEY, appLaneNonce } from "./internal/appNonceLane.js";
import capabilities from "./internal/fixtures/celo-sepolia-capabilities.json" with { type: "json" };
import prepared from "./internal/fixtures/celo-sepolia-prepare-calls.json" with { type: "json" };

const CALLS = [{ to: "0x2222222222222222222222222222222222222222" as Address, value: 0n, data: "0x" as Hex }];
/** `getNonce(uint192)` — what the SDK asks the account for. */
const GET_NONCE_SELECTOR = "0x3e1b0812";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Plays the relay and the public RPC. `laneCounter` is what the account answers
 * for the app lane; "undelegated" makes that read revert, as it does before a
 * wallet's delegation lands.
 */
function mockWire(laneCounter: bigint | "undelegated") {
  const nonces: (string | undefined)[] = [];
  let getNonceCalls = 0;
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const reqs = Array.isArray(body) ? body : [body];
    const answers = reqs.map((req: { id: number; method: string; params: any }) => {
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
      if (req.method === "eth_call") {
        const data = String(req.params?.[0]?.data ?? "");
        if (data.startsWith(GET_NONCE_SELECTOR)) {
          getNonceCalls += 1;
          if (laneCounter === "undelegated") {
            return { jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted" } };
          }
          return ok(numberToHex(appLaneNonce(laneCounter), { size: 32 }));
        }
        return ok("0x");
      }
      if (req.method === "eth_chainId") return ok(numberToHex(CELO_SEPOLIA.chainId));
      if (req.method === "wallet_getCapabilities") {
        return ok({ [numberToHex(CELO_SEPOLIA.chainId)]: capabilities["0xaa044c"] });
      }
      if (req.method === "wallet_getAssets") {
        return ok({
          [numberToHex(CELO_SEPOLIA.chainId)]: [
            { address: "native", balance: numberToHex(10n ** 18n), type: "native", metadata: null },
          ],
        });
      }
      if (req.method === "wallet_prepareCalls") {
        nonces.push(req.params?.[0]?.capabilities?.meta?.nonce);
        return ok(prepared);
      }
      if (req.method === "wallet_sendPreparedCalls") return ok({ id: "0xabc" });
      throw new Error(`unexpected ${req.method}`);
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { status: 200 });
  }) as typeof fetch;
  return { nonces, getNonceCalls: () => getNonceCalls };
}

const wallet = (n: number) => ({ address: `0x${n.toString(16).padStart(40, "0")}` as Address });
const run = (w: { address: Address }) =>
  execute(w, createPrivateKeySigner(), CALLS, { network: CELO_SEPOLIA, noWait: true });

describe("execute puts an app transaction on the SDK's lane", () => {
  test("the prepare carries a nonce on the app lane, not lane 0", async () => {
    const wire = mockWire(3n);
    const result = await run(wallet(0xc1));

    expect(result.callsId).toBe("0xabc");
    expect(wire.nonces).toHaveLength(1);
    const sent = BigInt(wire.nonces[0]!);
    expect(sent >> 64n).toBe(APP_LANE_SEQ_KEY);
    expect(sent & ((1n << 64n) - 1n)).toBe(3n);
    // The thing this is all for: not the lane the relay allocates from.
    expect(sent >> 64n).not.toBe(0n);
  });

  test("two back-to-back transactions carry consecutive counters", async () => {
    // The account's answer never changes, which is exactly the read-after-write
    // case that hands out one nonce twice on lane 0.
    const wire = mockWire(0n);
    const w = wallet(0xc2);
    await run(w);
    await run(w);
    await run(w);

    expect(wire.nonces.map((n) => BigInt(n!) & ((1n << 64n) - 1n))).toEqual([0n, 1n, 2n]);
    expect(wire.nonces.every((n) => BigInt(n!) >> 64n === APP_LANE_SEQ_KEY)).toBe(true);
  });

  test("an undelegated wallet sends no nonce, leaving the relay to choose", async () => {
    const wire = mockWire("undelegated");
    const result = await run(wallet(0xc3));

    expect(result.callsId).toBe("0xabc");
    expect(wire.nonces).toEqual([undefined]);
    expect(wire.getNonceCalls()).toBeGreaterThan(0);
  });
});
