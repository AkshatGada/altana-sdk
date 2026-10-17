/**
 * `execute` itself waits while this SDK has an intent in flight for the same
 * wallet on the same chain, over a mocked fetch that plays the relay.
 *
 * The module-level tests in `internal/pendingIntents.test.ts` cover the wait's
 * own behaviour. These cover the thing that matters to a caller: that no
 * `wallet_prepareCalls` leaves the SDK during the window, because the nonce the
 * relay would hand back is the one the in-flight intent is already using.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { numberToHex, type Address, type Hex } from "viem";
import { CELO_SEPOLIA, SEPOLIA } from "./config.js";
import { createPrivateKeySigner } from "./internal/signer.js";
import { execute } from "./execute.js";
import { holdPendingIntent } from "./internal/pendingIntents.js";
import capabilities from "./internal/fixtures/celo-sepolia-capabilities.json" with { type: "json" };
import prepared from "./internal/fixtures/celo-sepolia-prepare-calls.json" with { type: "json" };

const CALLS = [{ to: "0x2222222222222222222222222222222222222222" as Address, value: 0n, data: "0x" as Hex }];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Plays the Celo Sepolia relay and records every method it is asked for. */
function mockRelay() {
  const methods: string[] = [];
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const reqs = Array.isArray(body) ? body : [body];
    const answers = reqs.map((req: { id: number; method: string }) => {
      methods.push(req.method);
      if (req.method === "wallet_getCapabilities") {
        return { jsonrpc: "2.0", id: req.id, result: { [numberToHex(CELO_SEPOLIA.chainId)]: capabilities["0xaa044c"] } };
      }
      if (req.method === "wallet_getAssets") {
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: { [numberToHex(CELO_SEPOLIA.chainId)]: [{ address: "native", balance: numberToHex(10n ** 18n), type: "native", metadata: null }] },
        };
      }
      if (req.method === "wallet_prepareCalls") return { jsonrpc: "2.0", id: req.id, result: prepared };
      if (req.method === "wallet_sendPreparedCalls") return { jsonrpc: "2.0", id: req.id, result: { id: "0xabc" } };
      throw new Error(`relay got ${req.method}`);
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { status: 200 });
  }) as typeof fetch;
  return { methods, prepared: () => methods.filter((m) => m === "wallet_prepareCalls").length };
}

const tick = () => new Promise((r) => setTimeout(r, 2));
const wallet = (n: number) => ({ address: `0x${n.toString(16).padStart(40, "0")}` as Address });

describe("execute and a pending intent of this SDK's own", () => {
  test("during the window it waits, and goes once the intent is mined", async () => {
    const w = wallet(0xb1);
    const signer = createPrivateKeySigner();
    const relay = mockRelay();

    let mined!: () => void;
    holdPendingIntent(CELO_SEPOLIA.chainId, w.address, new Promise<void>((r) => (mined = r)));

    let settled = false;
    const run = execute(w, signer, CALLS, { network: CELO_SEPOLIA, noWait: true }).then((r) => {
      settled = true;
      return r;
    });

    // Give it every chance to go early.
    await tick();
    await tick();
    expect(settled).toBe(false);
    expect(relay.prepared()).toBe(0);

    mined();
    const result = await run;
    expect(result.callsId).toBe("0xabc");
    expect(relay.prepared()).toBe(1);
  });

  test("outside the window it is immediate", async () => {
    const w = wallet(0xb2);
    const signer = createPrivateKeySigner();
    const relay = mockRelay();

    const result = await execute(w, signer, CALLS, { network: CELO_SEPOLIA, noWait: true });

    expect(result.callsId).toBe("0xabc");
    expect(relay.prepared()).toBe(1);
  });

  test("a failed intent releases it: the execute goes rather than hanging", async () => {
    const w = wallet(0xb3);
    const signer = createPrivateKeySigner();
    const relay = mockRelay();

    let failed!: (e: Error) => void;
    holdPendingIntent(CELO_SEPOLIA.chainId, w.address, new Promise<void>((_, reject) => (failed = reject)));

    const run = execute(w, signer, CALLS, { network: CELO_SEPOLIA, noWait: true });
    await tick();
    expect(relay.prepared()).toBe(0);

    failed(new Error("the relay rejected the request to submit the call"));
    // Resolves normally: the registration's failure is not this execute's.
    const result = await run;
    expect(result.callsId).toBe("0xabc");
    expect(relay.prepared()).toBe(1);
  });

  test("a hold on another chain does not delay this one", async () => {
    const w = wallet(0xb4);
    const signer = createPrivateKeySigner();
    const relay = mockRelay();

    // Held on the registry chain, executing on Celo.
    holdPendingIntent(SEPOLIA.chainId, w.address, new Promise<void>(() => {}));

    const result = await execute(w, signer, CALLS, { network: CELO_SEPOLIA, noWait: true });
    expect(result.callsId).toBe("0xabc");
    expect(relay.prepared()).toBe(1);
  });

  test("a hold on another wallet does not delay this one", async () => {
    const signer = createPrivateKeySigner();
    const relay = mockRelay();

    holdPendingIntent(CELO_SEPOLIA.chainId, wallet(0xb5).address, new Promise<void>(() => {}));

    const result = await execute(wallet(0xb6), signer, CALLS, { network: CELO_SEPOLIA, noWait: true });
    expect(result.callsId).toBe("0xabc");
    expect(relay.prepared()).toBe(1);
  });
});
