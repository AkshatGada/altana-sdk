/**
 * LIVE (Celo Sepolia, via relay-staging) — a session key used on Celo BEFORE
 * its KeyStore registration on Ethereum Sepolia has confirmed.
 *
 * What this has to show, in order:
 *
 *   1. `grantSession` returns with the Celo authorization CONFIRMED and the
 *      Sepolia registry leg still `PENDING`.
 *   2. The session executes a real transaction on Celo while that registration
 *      is still in flight. Its block timestamp is recorded.
 *   3. The Sepolia `KeyRegistered` lands AFTER that execute, which is what
 *      makes "the key was usable before the L1 write" a measurement and not a
 *      claim.
 *   4. The cache proof follows, once the L2 anchors the registry block.
 *
 * Before this change the order was forced the other way: the Celo
 * authorization waited for the Sepolia write, so step 2 could not happen at
 * all (evidence/2026-10-15-demo-grant-did-authorize-on-celo.md).
 *
 * Needs:
 *   TEST_FUNDER_KEY        CELO on Celo Sepolia (>= 1)
 *   CELO_SEPOLIA_RPC_URL   optional read RPC override
 *   SEPOLIA_RPC_URL        optional registry-chain read RPC override
 *   ALTANA_RELAY_URL       optional relay override
 *
 * Run: bun run live:celo-first   (from tests/e2e)
 */
import {
  CELO_SEPOLIA,
  SEPOLIA,
  createClient,
  signerFromPrivateKey,
  waitForBalance,
  type GrantLeg,
  type NetworkConfig,
  type Session,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { celoSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFileSync, writeFileSync } from "node:fs";
import { testnetEnvFile } from "./testnet-env.js";

const RELAY = process.env.ALTANA_RELAY_URL ?? "https://relay-staging-production-2657.up.railway.app";
const CELO_FUNDING = parseEther("0.6");
/** What the session sends, to prove it can act at all. */
const PROBE = parseEther("0.001");

const l1Read = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
/**
 * One execution network, Celo Sepolia, with its registry chain pointed at the
 * same relay. Sepolia is deliberately NOT in `chains`: it is the registry
 * chain, reached through `registry.l1`, and the write there is paid from the
 * Celo balance.
 */
const network: NetworkConfig = {
  ...CELO_SEPOLIA,
  relayUrl: RELAY,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
  registry: {
    ...(CELO_SEPOLIA.registry as any),
    l1: { ...SEPOLIA, relayUrl: RELAY, publicRpcUrl: l1Read },
  },
} as NetworkConfig;

const pub = createPublicClient({ chain: celoSepolia, transport: http(network.publicRpcUrl) }) as PublicClient;
const sep = createPublicClient({ transport: http(l1Read) }) as PublicClient;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

const t0 = Date.now();
/** Seconds since the grant started, so every line is comparable. */
const at = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;

/** A transaction's block timestamp, which is the only clock both chains share. */
async function blockTime(client: PublicClient, hash: Hex): Promise<{ block: bigint; unix: number; iso: string }> {
  const receipt = await client.getTransactionReceipt({ hash });
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const unix = Number(block.timestamp);
  return { block: receipt.blockNumber, unix, iso: new Date(unix * 1000).toISOString() };
}

const record: Record<string, unknown> = { relay: RELAY, startedAt: new Date().toISOString() };

async function main() {
  console.log("LIVE: Celo-first grant, session used before the Sepolia registration");
  console.log("====================================================================\n");

  const funderKey = process.env.TEST_FUNDER_KEY as Hex;
  if (!funderKey) throw new Error("Set TEST_FUNDER_KEY: source the shared .env.testnet first.");
  const funder = privateKeyToAccount(funderKey);
  const fw = createWalletClient({ account: funder, chain: celoSepolia, transport: http(network.publicRpcUrl) });
  const funderBalance = await pub.getBalance({ address: funder.address });
  console.log(`funder ${funder.address}: ${formatEther(funderBalance)} CELO`);
  assert(funderBalance >= CELO_FUNDING * 2n, `the funder holds at least ${formatEther(CELO_FUNDING * 2n)} CELO`);

  const client = createClient({ chains: [network] });

  // ── A fresh wallet, so the registration really is a first-time write. ──
  const adminKey = generatePrivateKey();
  const admin = signerFromPrivateKey(adminKey);
  const wallet = await client.createWallet({ signer: admin });
  appendFileSync(
    testnetEnvFile(),
    `\n# live-celo-first-grant wallet ${wallet.address}, ${new Date().toISOString()}\n` +
      `CELOFIRST_${wallet.address.slice(2, 10).toUpperCase()}_KEY=${adminKey}\n`,
  );
  console.log(`\nwallet ${wallet.address} (key saved before funding)`);
  record.wallet = wallet.address;

  const fundTx = await fw.sendTransaction({ to: wallet.address, value: CELO_FUNDING, account: funder, chain: celoSepolia });
  await pub.waitForTransactionReceipt({ hash: fundTx });
  await waitForBalance(pub, wallet.address, CELO_FUNDING, 120_000);
  console.log(`funded ${formatEther(CELO_FUNDING)} CELO`);

  // ── 1. The grant. ──
  console.log("\n[1] grantSession on Celo Sepolia, registry on Ethereum Sepolia");
  const sessionKey = signerFromPrivateKey(generatePrivateKey());
  const events: string[] = [];
  const grant = await client.grantSession({
    wallet,
    signer: admin,
    sessionSigner: sessionKey,
    permissions: {
      calls: [{ to: funder.address }],
      spend: [{ limit: parseEther("0.05"), period: "day" }],
    },
    expiry: Math.floor(Date.now() / 1000) + 3600,
    onStatus: (status: string, detail?: { chainId?: number; step?: string; reason?: string }) => {
      const line = `${at()} ${status}${detail?.chainId ? ` chain ${detail.chainId}` : ""}${detail?.step ? ` (${detail.step})` : ""}${detail?.reason ? ` — ${detail.reason}` : ""}`;
      events.push(line);
      console.log(`    ${line}`);
    },
  });
  record.statusEvents = events;
  record.grantReturnedAt = at();

  const accountLeg = grant.legs.find((l: GrantLeg) => l.kind === "account" && l.chainId === network.chainId)!;
  const registryLegAtReturn = grant.legs.find((l: GrantLeg) => l.kind === "registry")!;
  console.log(`\n    returned at ${at()}: status=${grant.status}`);
  console.log(`    account  ${accountLeg.status}  ${network.explorer}/tx/${accountLeg.transactionHash}`);
  console.log(`    registry ${registryLegAtReturn.chainId}: ${registryLegAtReturn.status}`);
  assert(grant.status === "granted", `the grant is usable (${grant.status})`);
  assert(accountLeg.status === "CONFIRMED", "the Celo authorization confirmed");
  assert(
    registryLegAtReturn.status === "PENDING",
    "the Sepolia registry leg is still PENDING at return — the grant did not wait for it",
  );
  assert(
    grant.keyHash !== grant.keyId,
    `the result carries the account keyHash (${grant.keyHash.slice(0, 12)}…) as well as the KeyStore keyId (${grant.keyId.slice(0, 12)}…)`,
  );
  const authorization = await blockTime(pub, accountLeg.transactionHash!);
  console.log(`    Celo authorization at ${authorization.iso} (block ${authorization.block})`);
  record.celoAuthorization = { tx: accountLeg.transactionHash, ...authorization, block: String(authorization.block) };

  // The registration must still be running for step 2 to mean anything.
  const stillRunning = Symbol("running");
  const peek = await Promise.race([grant.registration, Promise.resolve(stillRunning)]);
  assert(peek === stillRunning, "and `registration` has not resolved yet");

  // ── 2. The session acts, while the registration is in flight. ──
  console.log("\n[2] execute with the SESSION key, registration still in flight");
  const session = grant as unknown as Session;
  const exec = await executeProbe(client, session, funder.address);
  record.sessionExecuteAttempts = exec.attempts;
  assert(exec.status === "CONFIRMED", `the session's transaction confirmed (${exec.status})`);
  const executed = await blockTime(pub, exec.hash);
  console.log(`    ${at()} session tx ${network.explorer}/tx/${exec.hash}`);
  console.log(`    executed at ${executed.iso} (block ${executed.block})`);
  record.sessionExecute = { tx: exec.hash, ...executed, block: String(executed.block) };

  // Read the registry at that moment: this is the claim, checked rather than assumed.
  const registeredYet = await isRegistered(wallet.address, grant.keyId);
  console.log(`    KeyStore.isValidKey at this point: ${registeredYet}`);
  record.registeredAtExecuteTime = registeredYet;

  // ── 3. The registration lands, after the execute. ──
  console.log("\n[3] wait for the Sepolia registration");
  const registryLegs = await grant.registration;
  const sepoliaLeg = registryLegs.find((l: GrantLeg) => l.chainId === SEPOLIA.chainId)!;
  console.log(`    ${at()} registry ${sepoliaLeg.status} ${sepoliaLeg.via ? `via ${sepoliaLeg.via}` : ""}`);
  if (sepoliaLeg.reason) console.log(`    reason: ${sepoliaLeg.reason}`);
  if (sepoliaLeg.rootRegistration) {
    console.log(`    root (initialRegisterKey): ${sepoliaLeg.rootRegistration.status} ${sepoliaLeg.rootRegistration.transactionHash ?? ""}`);
  }
  record.sepoliaRegistryLeg = {
    status: sepoliaLeg.status,
    via: sepoliaLeg.via,
    tx: sepoliaLeg.transactionHash,
    block: sepoliaLeg.blockNumber === undefined ? undefined : String(sepoliaLeg.blockNumber),
    fundedFromChainId: sepoliaLeg.fundedFromChainId,
    sourceTransactionHash: sepoliaLeg.sourceTransactionHash,
    reason: sepoliaLeg.reason,
    rootRegistration: sepoliaLeg.rootRegistration
      ? { ...sepoliaLeg.rootRegistration, blockNumber: sepoliaLeg.rootRegistration.blockNumber === undefined ? undefined : String(sepoliaLeg.rootRegistration.blockNumber) }
      : undefined,
  };
  assert(sepoliaLeg.status === "CONFIRMED", `the KeyStore registration confirmed (${sepoliaLeg.status}: ${sepoliaLeg.reason ?? ""})`);

  const registered = await blockTime(sep, sepoliaLeg.transactionHash!);
  console.log(`    Sepolia KeyRegistered at ${registered.iso} (block ${registered.block})`);
  record.sepoliaRegistration = { tx: sepoliaLeg.transactionHash, ...registered, block: String(registered.block) };
  assert(
    registered.unix > executed.unix,
    `the registration landed AFTER the session's transaction ` +
      `(${registered.iso} > ${executed.iso}, +${registered.unix - executed.unix}s)`,
  );
  assert(await isRegistered(wallet.address, grant.keyId), "and the key is valid in the KeyStore now");

  // ── 4. The cache proof, which needed the write's block. ──
  console.log("\n[4] cache proof into the Celo KeyStoreCache");
  const caches = await grant.cacheSync;
  const cache = caches.find((l: GrantLeg) => l.chainId === network.chainId);
  console.log(`    ${at()} cache ${cache?.status}${cache?.reason ? ` — ${cache.reason}` : ""}`);
  if (cache?.transactionHash) console.log(`    ${network.explorer}/tx/${cache.transactionHash}`);
  record.cacheLeg = {
    status: cache?.status,
    tx: cache?.transactionHash,
    l1BlockNumber: cache?.l1BlockNumber === undefined ? undefined : String(cache.l1BlockNumber),
    reason: cache?.reason,
  };

  const usable = executed.unix - authorization.unix;
  const l1Wait = registered.unix - authorization.unix;
  console.log(`\n    session usable ${usable}s after the Celo authorization`);
  console.log(`    the L1 registration would have made it wait ${l1Wait}s`);
  record.secondsAuthorizationToExecute = usable;
  record.secondsAuthorizationToRegistration = l1Wait;

  await sweep(wallet.address, adminKey, funder.address);

  writeFileSync(
    new URL("./celo-first-grant-run.json", import.meta.url),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  console.log("\n====================================================================");
  console.log("Result: PASS — the session acted on Celo before its Sepolia registration confirmed.");
}

/**
 * The session's transaction. The registration is paid by an intent from this
 * same account on Celo, and the relay reserves no nonce for an intent it has
 * not mined (2026-09-28-back-to-back-race-attribution.md), so an execute that
 * overlaps it can come back with a nonce error. Retried, and every attempt is
 * recorded: a collision here is a finding, not something to hide.
 */
async function executeProbe(
  client: ReturnType<typeof createClient>,
  session: Session,
  to: Address,
): Promise<{ status: string; hash: Hex; attempts: string[] }> {
  const attempts: string[] = [];
  for (let i = 1; i <= 5; i++) {
    try {
      const r = await client.execute({ session, chainId: 11142220, calls: { to, value: PROBE, data: "0x" } });
      attempts.push(`${at()} attempt ${i}: ${r.status}`);
      if (r.status === "CONFIRMED") return { status: r.status, hash: r.transactionHash as Hex, attempts };
      console.log(`    attempt ${i} came back ${r.status}`);
    } catch (err) {
      const msg = (err as Error).message.split("\n")[0]!;
      attempts.push(`${at()} attempt ${i} threw: ${msg}`);
      console.log(`    attempt ${i} threw: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, 4_000));
  }
  return { status: "FAILED", hash: "0x" as Hex, attempts };
}

const KEYSTORE_ABI = [
  {
    name: "isValidKey",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

function isRegistered(wallet: Address, keyId: Hex): Promise<boolean> {
  return sep.readContract({
    address: SEPOLIA.keyStore,
    abi: KEYSTORE_ABI,
    functionName: "isValidKey",
    args: [wallet, keyId],
  }).catch(() => false) as Promise<boolean>;
}

/** Returns what is left to the funder. Best effort, logged, never throws. */
async function sweep(wallet: Address, adminKey: Hex, funder: Address) {
  console.log("\n[sweep] return leftover funds to the funder");
  const admin = signerFromPrivateKey(adminKey);
  const client = createClient({ chains: [network] });
  try {
    const bal = await pub.getBalance({ address: wallet });
    const keep = parseEther("0.05");
    if (bal > keep) {
      const r = await client.execute({
        wallet: { address: wallet },
        signer: admin,
        calls: { to: funder, value: bal - keep, data: "0x" },
      });
      console.log(`    returned ${formatEther(bal - keep)} CELO (${r.status})`);
    } else {
      console.log(`    ${formatEther(bal)} CELO left, below the ${formatEther(keep)} fee reserve; nothing returned`);
    }
  } catch (e) {
    console.log(`    CELO sweep failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

main().catch((e) => {
  console.error("\nResult: FAIL");
  console.error(e);
  try {
    writeFileSync(new URL("./celo-first-grant-run.json", import.meta.url), `${JSON.stringify({ ...record, failure: String(e) }, null, 2)}\n`);
  } catch {}
  process.exit(1);
});
