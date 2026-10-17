/**
 * LIVE (Celo Sepolia, via relay-staging) — several app transactions fired while
 * a grant's KeyStore registration is still in flight, none of them colliding
 * with it for a nonce.
 *
 * What it has to show:
 *
 *   1. `grantSession` returns with the Sepolia registry leg still `PENDING`.
 *   2. Three session transactions are fired AT ONCE, immediately, while that
 *      registration is running. Every one confirms on its FIRST attempt with no
 *      `InvalidNonce`, and none of them waits for the registration.
 *   3. Read back from the Orchestrator's own `IntentExecuted`: the three
 *      transactions sit on the SDK's lane (`0xa17a…`) with consecutive
 *      counters, and the registration's funding intents sit on lane 0. Two
 *      counters, no contention.
 *
 * Before the lane (2026-10-17, same script path) the app's execute took a
 * lane-0 counter *between* the registration's two funding intents, and only
 * timing kept it from colliding — see evidence/2026-10-17-nonce-lanes.md.
 *
 * Needs:
 *   TEST_FUNDER_KEY        CELO on Celo Sepolia (>= 5)
 *   CELO_SEPOLIA_RPC_URL   optional read RPC override
 *   SEPOLIA_RPC_URL        optional registry-chain read RPC override
 *   ALTANA_RELAY_URL       optional relay override
 *   APP_LANE_TX_COUNT      how many to fire at once (default 3)
 *
 * Run: bun run live:app-lane   (from tests/e2e)
 */
import {
  CELO_SEPOLIA,
  SEPOLIA,
  createClient,
  sdkBuild,
  signerFromPrivateKey,
  waitForBalance,
  type GrantLeg,
  type NetworkConfig,
  type Session,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  formatEther,
  http,
  parseEther,
  parseGwei,
  toEventSelector,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { celoSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFileSync, writeFileSync } from "node:fs";
import { testnetEnvFile } from "./testnet-env.js";

const RELAY = process.env.ALTANA_RELAY_URL ?? "https://relay-staging-production-2657.up.railway.app";
const TX_COUNT = Number(process.env.APP_LANE_TX_COUNT ?? "3");
/** One relayed operation costs about 0.3 CELO at the live 1,500,000 buffer. */
const CELO_FUNDING = parseEther("2.5");
const PROBE = parseEther("0.001");

/** The lane the SDK puts app transactions on. Asserted, not imported, so this is a real check. */
const APP_LANE_SEQ_KEY = (0xa17an << 176n) | 1n;
const INTENT_EXECUTED = toEventSelector("IntentExecuted(address,uint256,bool,bytes4)");
const INTENT_EXECUTED_ABI = [
  {
    type: "event",
    name: "IntentExecuted",
    inputs: [
      { name: "eoa", type: "address", indexed: true },
      { name: "nonce", type: "uint256", indexed: true },
      { name: "incremented", type: "bool", indexed: false },
      { name: "err", type: "bytes4", indexed: false },
    ],
  },
] as const;

const l1Read = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const network: NetworkConfig = {
  ...CELO_SEPOLIA,
  relayUrl: RELAY,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
  registry: { ...(CELO_SEPOLIA.registry as any), l1: { ...SEPOLIA, relayUrl: RELAY, publicRpcUrl: l1Read } },
} as NetworkConfig;

const pub = createPublicClient({ chain: celoSepolia, transport: http(network.publicRpcUrl) }) as PublicClient;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

const t0 = Date.now();
const at = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const record: Record<string, unknown> = { relay: RELAY, startedAt: new Date().toISOString(), txCount: TX_COUNT };

/** The lane and counter of every intent in a transaction, for this wallet. */
async function intentsIn(hash: Hex, wallet: Address) {
  // forno is load balanced; the node that served a receipt need not have it.
  for (let i = 0; i < 10; i++) {
    try {
      const r = await pub.getTransactionReceipt({ hash });
      const out: { nonce: bigint; seqKey: bigint; counter: bigint; onAppLane: boolean }[] = [];
      for (const l of r.logs) {
        if (l.topics[0] !== INTENT_EXECUTED) continue;
        const { args } = decodeEventLog({ abi: INTENT_EXECUTED_ABI, topics: l.topics, data: l.data });
        if (String((args as any).eoa).toLowerCase() !== wallet.toLowerCase()) continue;
        const nonce = (args as any).nonce as bigint;
        const seqKey = nonce >> 64n;
        out.push({ nonce, seqKey, counter: nonce & ((1n << 64n) - 1n), onAppLane: seqKey === APP_LANE_SEQ_KEY });
      }
      return out;
    } catch {
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  return [];
}

const laneName = (seqKey: bigint) =>
  seqKey === 0n ? "LANE 0 (the relay's)" : seqKey === APP_LANE_SEQ_KEY ? "APP LANE 0xa17a…0001" : `other lane 0x${seqKey.toString(16)}`;

async function main() {
  console.log("LIVE: app transactions on their own nonce lane, during a registration");
  console.log("====================================================================\n");
  console.log(`sdk build ${sdkBuild.describe}`);
  record.sdkBuild = sdkBuild.describe;
  if (sdkBuild.dirty) console.log("  (dirty tree: rebuild with `bun run --cwd packages/wallet build` if src changed)");

  const funderKey = process.env.TEST_FUNDER_KEY as Hex;
  if (!funderKey) throw new Error("Set TEST_FUNDER_KEY: source the shared .env.testnet first.");
  const funder = privateKeyToAccount(funderKey);
  const fw = createWalletClient({ account: funder, chain: celoSepolia, transport: http(network.publicRpcUrl) });
  const funderBalance = await pub.getBalance({ address: funder.address });
  console.log(`funder ${funder.address}: ${formatEther(funderBalance)} CELO`);
  assert(funderBalance >= CELO_FUNDING + parseEther("0.5"), `the funder covers ${formatEther(CELO_FUNDING)} CELO`);

  const client = createClient({ chains: [network] });

  // ── A fresh wallet, so the registration is a first-time two-intent write. ──
  const adminKey = generatePrivateKey();
  const admin = signerFromPrivateKey(adminKey);
  const wallet = await client.createWallet({ signer: admin });
  appendFileSync(
    testnetEnvFile(),
    `\n# live-app-nonce-lane wallet ${wallet.address}, ${new Date().toISOString()}\n` +
      `APPLANE_${wallet.address.slice(2, 10).toUpperCase()}_KEY=${adminKey}\n`,
  );
  console.log(`\nwallet ${wallet.address} (fresh; key saved before funding)`);
  record.wallet = wallet.address;

  const fundTx = await fw.sendTransaction({ to: wallet.address, value: CELO_FUNDING, account: funder, chain: celoSepolia });
  await pub.waitForTransactionReceipt({ hash: fundTx });
  await waitForBalance(pub, wallet.address, CELO_FUNDING, 120_000);
  console.log(`funded ${formatEther(CELO_FUNDING)} CELO`);

  // ── 1. Grant. ──
  console.log("\n[1] grantSession on Celo Sepolia, registry on Ethereum Sepolia");
  const sessionPrivateKey = generatePrivateKey();
  const events: string[] = [];
  const grant = await client.grantSession({
    wallet,
    signer: admin,
    sessionSigner: signerFromPrivateKey(sessionPrivateKey),
    permissions: {
      calls: [{ to: funder.address }],
      // The session pays the relay's fee from its own cap, about 0.3 CELO each.
      spend: [{ limit: parseEther("2"), period: "day" }],
    },
    expiry: Math.floor(Date.now() / 1000) + 3600,
    onStatus: (status: string, detail?: { chainId?: number; step?: string; reason?: string }) => {
      const line = `${at()} ${status}${detail?.chainId ? ` chain ${detail.chainId}` : ""}${detail?.step ? ` (${detail.step})` : ""}${detail?.reason ? ` — ${detail.reason}` : ""}`;
      events.push(line);
      console.log(`    ${line}`);
    },
  });
  record.statusEvents = events;
  appendFileSync(
    testnetEnvFile(),
    `APPLANE_SESSION_${wallet.address.slice(2, 10).toUpperCase()}_KEY=${sessionPrivateKey}\n`,
  );

  const registryLeg = grant.legs.find((l: GrantLeg) => l.kind === "registry")!;
  console.log(`\n    returned at ${at()}: status=${grant.status}, registry ${registryLeg.chainId}: ${registryLeg.status}`);
  assert(grant.status === "granted", `the grant is usable (${grant.status})`);
  assert(registryLeg.status === "PENDING", "the Sepolia registry leg is still PENDING, so the registration is in flight");
  record.grantReturnedAt = at();

  // ── 2. Several app transactions, fired at once, during the registration. ──
  console.log(`\n[2] firing ${TX_COUNT} session transactions AT ONCE, registration still in flight`);
  const session = grant as unknown as Session;
  const firedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: TX_COUNT }, (_, i) =>
      client
        .execute({ session, chainId: network.chainId, calls: { to: funder.address, value: PROBE, data: "0x" } })
        .then((r) => ({ i, ok: true as const, r }))
        .catch((e) => ({ i, ok: false as const, e: e as Error })),
    ),
  );
  const elapsed = (Date.now() - firedAt) / 1000;
  console.log(`    all ${TX_COUNT} settled after ${elapsed.toFixed(1)}s`);
  record.allSettledSeconds = Number(elapsed.toFixed(1));

  const failures = results.filter((x) => !x.ok) as Extract<(typeof results)[number], { ok: false }>[];
  for (const f of failures) console.log(`    tx ${f.i} threw: ${f.e.message.split("\n")[0]}`);
  const nonceErrors = failures.filter((f) => /InvalidNonce|invalid nonce/i.test(f.e.message));
  record.failures = failures.map((f) => f.e.message.split("\n")[0]);
  assert(nonceErrors.length === 0, `no transaction hit InvalidNonce (${nonceErrors.length} did)`);
  assert(failures.length === 0, `every transaction went through on its first attempt (${failures.length} failed)`);

  const ok = results.filter((x) => x.ok) as Extract<(typeof results)[number], { ok: true }>[];
  const hashes: Hex[] = [];
  for (const { i, r } of ok) {
    console.log(`    tx ${i}: ${r.status} ${network.explorer}/tx/${r.transactionHash}`);
    assert(r.status === "CONFIRMED", `tx ${i} confirmed (${r.status})`);
    hashes.push(r.transactionHash as Hex);
  }
  record.appTxs = hashes;

  // ── 3. The lanes, read off the Orchestrator's own event. ──
  console.log("\n[3] nonce lanes, from IntentExecuted");
  const appLaneCounters: bigint[] = [];
  for (const [i, h] of hashes.entries()) {
    for (const intent of await intentsIn(h, wallet.address)) {
      console.log(`    app tx ${i}  counter ${intent.counter}  ${laneName(intent.seqKey)}`);
      assert(intent.onAppLane, `app tx ${i} ran on the SDK's lane, not the relay's`);
      appLaneCounters.push(intent.counter);
    }
  }
  record.appLaneCounters = appLaneCounters.map(String);
  const sorted = [...appLaneCounters].sort((a, b) => (a < b ? -1 : 1));
  assert(
    sorted.every((c, i) => i === 0 || c === sorted[i - 1]! + 1n),
    `the app lane's counters are consecutive (${sorted.join(", ")})`,
  );

  // ── 4. The registration's own intents, on lane 0. ──
  console.log("\n[4] the registration, and the lane it used");
  const registryLegs = await grant.registration;
  const sepolia = registryLegs.find((l: GrantLeg) => l.chainId === SEPOLIA.chainId)!;
  console.log(`    ${at()} registry ${sepolia.status}${sepolia.reason ? ` — ${sepolia.reason}` : ""}`);
  record.registryLeg = { status: sepolia.status, tx: sepolia.transactionHash, reason: sepolia.reason };
  if (sepolia.sourceTransactionHash) {
    for (const intent of await intentsIn(sepolia.sourceTransactionHash as Hex, wallet.address)) {
      console.log(`    registration source intent  counter ${intent.counter}  ${laneName(intent.seqKey)}`);
      assert(intent.seqKey === 0n, "the registration's funding intent stayed on lane 0");
      record.registrationSourceLane = laneName(intent.seqKey);
    }
  } else {
    console.log("    (no source transaction recorded on the leg)");
  }

  await sweep(wallet.address, adminKey, funder.address);
  record.verdict = `PASS: ${TX_COUNT} app transactions during a live registration, no InvalidNonce, app lane vs lane 0`;
  writeFileSync(
    new URL(`./app-nonce-lane-run-${new Date().toISOString().slice(0, 10)}-${String(record.sdkBuild).replace(/[^a-zA-Z0-9]/g, "")}.json`, import.meta.url),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  console.log("\n====================================================================");
  console.log(`Result: ${record.verdict}`);
}

/** Returns what is left to the funder, as a plain EOA transfer. */
async function sweep(wallet: Address, adminKey: Hex, funder: Address) {
  console.log("\n[sweep] return leftover funds to the funder");
  try {
    const account = privateKeyToAccount(adminKey);
    const bal = await pub.getBalance({ address: wallet });
    const gasPrice = parseGwei("70");
    const cost = 21_000n * gasPrice;
    if (bal <= cost * 2n) {
      console.log(`    ${formatEther(bal)} CELO left, at or below the gas it would cost; left in place`);
      return;
    }
    const w = createWalletClient({ account, chain: celoSepolia, transport: http(network.publicRpcUrl) });
    const hash = await w.sendTransaction({ to: funder, value: bal - cost, gas: 21_000n, gasPrice });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`    returned ${formatEther(bal - cost)} CELO  ${hash}`);
    record.swept = { value: formatEther(bal - cost), tx: hash };
  } catch (e) {
    console.log(`    sweep failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

main().catch((e) => {
  console.error("\nResult: FAIL");
  console.error(e);
  process.exit(1);
});
