/**
 * Circle Gateway wrapper — server-side cross-chain USDC transfers.
 *
 * MERIDIAN runs on three roles, two chains:
 *
 *   - Treasury USDC custody  → Arbitrum Sepolia (CoFHE-supported, where the hook lives).
 *   - Polymarket trading EOA → Polygon Amoy testnet (Polymarket has always been Polygon-native).
 *   - Hook + fhUSDC settlement → Arbitrum Sepolia (Fhenix CoFHE testnet coverage).
 *
 * Per position lifecycle:
 *
 *   1. /open    treasury (Arb Sepolia)  → unified balance → mint to burner (Polygon Amoy)  → CLOB submit
 *   2. /resolve burner   (Polygon Amoy) → unified balance → mint to treasury (Arb Sepolia) → settle
 *
 * Why Gateway? Gateway's testnet DOES cover Arb Sepolia (domain 3) and Polygon Amoy
 * (domain 7). Sub-500ms transfers, unified balance accounting, and — with the
 * Forwarding Service — Circle handles the destination mint so cogito doesn't
 * need a hot wallet or native gas on the destination chain.
 *
 * Two routes:
 *   POST /bridge/deposit  — approve + deposit USDC into the GatewayWallet (one-time
 *                            for treasury; per-resolve for burner).
 *   POST /bridge          — sign EIP-712 BurnIntent, submit to Gateway API with
 *                            ?enableForwarder=true, poll /v1/transfer/{id} until
 *                            the forwarder confirms the destination mint.
 *
 * This module is internal to cogito — execution-router POSTs from localhost
 * with the standard cogito bearer-token; we never expose it past the loopback.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  pad,
  zeroAddress,
  erc20Abi,
  type Hex,
  type WalletClient,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  GATEWAY_TESTNET_API,
  chainByKey,
  TESTNET_CHAINS,
  type GatewayChain,
} from "./gatewayChains.js";

// ── Gateway minter ABI (the only function we call on-chain on dest).
//    Kept for parity with the non-forwarder code path; in the forwarded flow
//    Circle does the mint, so we never invoke this.
const gatewayMinterAbi = [
  {
    type: "function",
    name: "gatewayMint",
    inputs: [
      { name: "attestationPayload", type: "bytes" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// ── GatewayWallet ABI — only `deposit(token, value)` is needed; ERC20 approve
//    is handled via the standard erc20Abi from viem.
const gatewayWalletAbi = [
  {
    type: "function",
    name: "deposit",
    inputs: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// ── EIP-712 types — copied verbatim from Circle's reference. Per the
//    use-gateway skill rules: "NEVER modify EIP-712 type definitions, domain
//    separators, struct hashes ... Use them exactly as written."
const EIP712_DOMAIN_DEF = {
  name: "GatewayWallet",
  version: "1",
} as const;

const EIP712_TYPES = {
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
} as const;

// ── Zod schemas ──────────────────────────────────────────────────────────────

// signer = treasury (uses TREASURY_PRIVATE_KEY) | burner (caller passes the key inline).
const Signer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("treasury") }),
  z.object({
    kind: z.literal("burner"),
    private_key: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "burner.private_key must be 0x + 64 hex"),
  }),
]);

// Friendly chain keys — registered in gatewayChains.ts. Tightens the surface
// vs. accepting arbitrary domain ints from the wire.
const ChainKey = z.enum(["arbitrum_sepolia", "polygon_amoy"]);

// Decimal USDC string with up to 6 decimals.
const UsdcAmount = z.string().regex(
  /^\d+(\.\d{1,6})?$/,
  "amount must be a decimal USDC string with at most 6 decimals",
);

const DepositBody = z.object({
  chain: ChainKey,
  amount: UsdcAmount,
  signer: Signer,
});

const BridgeBody = z.object({
  from_chain: ChainKey,
  to_chain: ChainKey,
  amount: UsdcAmount,
  signer: Signer,
  // Default recipient = source signer's address. Override for treasury→burner.
  recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  // For the demo we always use the forwarder; flag is here in case we later
  // want to settle directly via gatewayMint (would require the caller to also
  // supply a destination-chain wallet with native gas).
  use_forwarder: z.boolean().optional(),
});

type BridgeBodyT = z.infer<typeof BridgeBody>;
type DepositBodyT = z.infer<typeof DepositBody>;

// ── Step + result shape: kept compatible with the previous Bridge Kit shape
//    so bridge_client.py's BridgeStep mapping (burn_tx / mint_tx) keeps working.
//    For Gateway we surface:
//      burn  → transferId   (Circle's source-side burn isn't a tx the user broadcasts)
//      mint  → forwardTxHash from /v1/transfer/{id}
interface StepRecord {
  name: string;
  state: "success" | "pending" | "failed";
  tx_hash: string | null;
  explorer_url: string | null;
  detail?: string;
}

interface BridgeRoutes {
  router: Hono;
  ready: boolean;
  status: () => Promise<{
    treasuryBalance: number | null;
    balances: Array<{ domain: number; balance: number }>;
    depositor: string | null;
  }>;
}

const POLL_INTERVAL_MS = Number(process.env.GATEWAY_POLL_INTERVAL_MS ?? 4_000);
const POLL_TIMEOUT_MS = Number(process.env.GATEWAY_POLL_TIMEOUT_MS ?? 240_000);

export function createBridgeRoutes(): BridgeRoutes {
  const router = new Hono();
  const treasuryKey = process.env.TREASURY_PRIVATE_KEY;
  const ready = !!treasuryKey;

  router.post("/", async (c) => {
    const parsed = BridgeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.message });
    }
    const body = parsed.data;
    if (body.from_chain === body.to_chain) {
      throw new HTTPException(400, { message: "from_chain and to_chain must differ" });
    }

    try {
      const result = await runBridge(body, treasuryKey);
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HTTPException(502, { message: `bridge failed: ${message}` });
    }
  });

  router.post("/deposit", async (c) => {
    const parsed = DepositBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.message });
    }
    try {
      const result = await runDeposit(parsed.data, treasuryKey);
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HTTPException(502, { message: `deposit failed: ${message}` });
    }
  });

  return {
    router,
    ready,
    status: async () => {
      if (!treasuryKey) {
        return { treasuryBalance: null, balances: [], depositor: null };
      }
      const depositor = privateKeyToAccount(ensure0xPrefixed(treasuryKey) as Hex).address;
      try {
        const balances = await fetchGatewayBalances(depositor);
        const total = balances.reduce((sum, item) => sum + item.balance, 0);
        return { treasuryBalance: total, balances, depositor };
      } catch {
        return { treasuryBalance: null, balances: [], depositor };
      }
    },
  };
}

// ── Deposit: approve + deposit USDC into the source chain's GatewayWallet.

async function runDeposit(body: DepositBodyT, treasuryKey: string | undefined) {
  const chain = chainByKey(body.chain);
  const account = resolveAccount(body.signer, treasuryKey);
  const amount = parseUnits(body.amount, 6);

  const { walletClient, publicClient } = clientsFor(chain, account);

  const steps: StepRecord[] = [];

  // 1. approve(USDC, gatewayWallet, amount)
  const approveHash = await walletClient.writeContract({
    address: chain.usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [chain.gatewayWallet, amount],
    account,
    chain: chain.viemChain,
  });
  steps.push({
    name: "approve",
    state: "pending",
    tx_hash: approveHash,
    explorer_url: explorerUrl(chain, approveHash),
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  steps[steps.length - 1].state = "success";

  // 2. deposit(USDC, amount) on GatewayWallet
  const depositHash = await walletClient.writeContract({
    address: chain.gatewayWallet,
    abi: gatewayWalletAbi,
    functionName: "deposit",
    args: [chain.usdc, amount],
    account,
    chain: chain.viemChain,
  });
  steps.push({
    name: "deposit",
    state: "pending",
    tx_hash: depositHash,
    explorer_url: explorerUrl(chain, depositHash),
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });
  steps[steps.length - 1].state = "success";

  return {
    ok: true,
    state: "success",
    chain: chain.key,
    domain: chain.domain,
    depositor: account.address,
    amount: body.amount,
    steps,
  };
}

// ── Bridge: estimate → sign → submit (forwarder) → poll.

async function runBridge(body: BridgeBodyT, treasuryKey: string | undefined) {
  const useForwarder = body.use_forwarder ?? true; // default ON for hackathon
  const fromChain = chainByKey(body.from_chain);
  const toChain = chainByKey(body.to_chain);
  const account = resolveAccount(body.signer, treasuryKey);
  const recipient = (body.recipient ?? account.address) as Hex;
  const value = parseUnits(body.amount, 6);

  const steps: StepRecord[] = [];

  // 1. Build TransferSpec (with bytes32-padded address fields).
  const specRaw = {
    version: 1,
    sourceDomain: fromChain.domain,
    destinationDomain: toChain.domain,
    sourceContract: fromChain.gatewayWallet,
    destinationContract: toChain.gatewayMinter,
    sourceToken: fromChain.usdc,
    destinationToken: toChain.usdc,
    sourceDepositor: account.address as Hex,
    destinationRecipient: recipient,
    sourceSigner: account.address as Hex,
    destinationCaller: zeroAddress as Hex,
    value: value.toString(),
    salt: randomHex32(),
    hookData: "0x" as Hex,
  };

  const specBytes32 = {
    ...specRaw,
    sourceContract: addr32(specRaw.sourceContract),
    destinationContract: addr32(specRaw.destinationContract),
    sourceToken: addr32(specRaw.sourceToken),
    destinationToken: addr32(specRaw.destinationToken),
    sourceDepositor: addr32(specRaw.sourceDepositor),
    destinationRecipient: addr32(specRaw.destinationRecipient),
    sourceSigner: addr32(specRaw.sourceSigner),
    destinationCaller: addr32(specRaw.destinationCaller),
  };

  // 2. Estimate maxFee + maxBlockHeight from Gateway.
  const estimateUrl = `${GATEWAY_TESTNET_API}/v1/estimate?enableForwarder=${useForwarder}`;
  const estimateResp = await fetch(estimateUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ spec: specBytes32 }], (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  if (!estimateResp.ok) {
    const text = await estimateResp.text();
    throw new Error(`estimate ${estimateResp.status}: ${text}`);
  }
  const estimateJson: any = await estimateResp.json();
  const estimated = estimateJson?.body?.[0]?.burnIntent;
  if (!estimated) {
    throw new Error(`estimate response missing burnIntent: ${JSON.stringify(estimateJson)}`);
  }
  const maxFee = BigInt(estimated.maxFee);
  const maxBlockHeight = BigInt(estimated.maxBlockHeight);
  steps.push({
    name: "estimate",
    state: "success",
    tx_hash: null,
    explorer_url: null,
    detail: `maxFee=${maxFee.toString()} maxBlockHeight=${maxBlockHeight.toString()}`,
  });

  // 3. Sign the EIP-712 BurnIntent.
  const burnIntentMessage = {
    maxBlockHeight,
    maxFee,
    spec: specBytes32,
  };

  const signature = await account.signTypedData({
    domain: EIP712_DOMAIN_DEF,
    types: EIP712_TYPES,
    primaryType: "BurnIntent",
    message: burnIntentMessage as any,
  });
  steps.push({
    name: "burnSigned",
    state: "success",
    tx_hash: null,
    explorer_url: null,
    detail: `signer=${account.address}`,
  });

  // 4. Submit to Gateway /v1/transfer.
  const transferUrl = `${GATEWAY_TESTNET_API}/v1/transfer?enableForwarder=${useForwarder}`;
  const transferResp = await fetch(transferUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      [{ burnIntent: burnIntentMessage, signature }],
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    ),
  });
  if (!transferResp.ok) {
    const text = await transferResp.text();
    throw new Error(`transfer ${transferResp.status}: ${text}`);
  }
  const transferJson: any = await transferResp.json();
  const transferId: string | undefined = transferJson.transferId;
  if (!transferId) {
    throw new Error(`transfer response missing transferId: ${JSON.stringify(transferJson)}`);
  }
  steps.push({
    name: "burn",
    state: "success",
    tx_hash: transferId, // Map transferId to burn_tx for downstream parity.
    explorer_url: null,
    detail: "transferId from /v1/transfer",
  });

  // 5. Poll /v1/transfer/{id} until forwarder finalizes.
  const pollStart = Date.now();
  let mintTx: string | null = null;
  let lastStatus = "pending";
  let lastDetails: any = null;
  while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
    const pollResp = await fetch(`${GATEWAY_TESTNET_API}/v1/transfer/${transferId}`);
    if (!pollResp.ok) {
      // Soft-tolerate transient poll failures.
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    lastDetails = await pollResp.json();
    lastStatus = lastDetails?.status ?? lastStatus;

    if (lastStatus === "finalized" || lastStatus === "confirmed") {
      mintTx =
        lastDetails?.forwardingDetails?.forwardTxHash ??
        lastDetails?.destinationDetails?.txHash ??
        null;
      break;
    }
    if (lastStatus === "failed") {
      const reason = lastDetails?.forwardingDetails?.failureReason ?? "unknown";
      throw new Error(`gateway transfer failed: ${reason}`);
    }
    if (lastStatus === "expired") {
      throw new Error("gateway burn intent expired before forwarding");
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!mintTx && lastStatus !== "finalized" && lastStatus !== "confirmed") {
    throw new Error(
      `gateway transfer did not complete within ${POLL_TIMEOUT_MS}ms (last status: ${lastStatus})`,
    );
  }

  steps.push({
    name: "mint",
    state: "success",
    tx_hash: mintTx,
    explorer_url: mintTx ? explorerUrl(toChain, mintTx) : null,
    detail: `forwarder mint on ${toChain.key} (status=${lastStatus})`,
  });

  return {
    ok: true,
    state: "success",
    transferId,
    amount: body.amount,
    from: { chain: fromChain.key, domain: fromChain.domain, address: account.address },
    to: { chain: toChain.key, domain: toChain.domain, address: recipient },
    steps,
    provider: "circle-gateway",
    forwarder: useForwarder,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function resolveAccount(
  signer: z.infer<typeof Signer>,
  treasuryKey: string | undefined,
): PrivateKeyAccount {
  if (signer.kind === "treasury") {
    if (!treasuryKey) {
      throw new HTTPException(500, { message: "TREASURY_PRIVATE_KEY not configured" });
    }
    return privateKeyToAccount(ensure0xPrefixed(treasuryKey) as Hex);
  }
  return privateKeyToAccount(signer.private_key as Hex);
}

function clientsFor(chain: GatewayChain, account: PrivateKeyAccount): {
  walletClient: WalletClient;
  publicClient: PublicClient;
} {
  const transport = http(chain.rpcUrl);
  const walletClient = createWalletClient({ chain: chain.viemChain, transport, account });
  const publicClient = createPublicClient({ chain: chain.viemChain, transport });
  return { walletClient, publicClient };
}

function ensure0xPrefixed(key: string): string {
  return key.startsWith("0x") ? key : `0x${key}`;
}

function addr32(addr: Hex): Hex {
  return pad(addr.toLowerCase() as Hex, { size: 32 });
}

function randomHex32(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return (`0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`) as Hex;
}

function explorerUrl(chain: GatewayChain, tx: string): string | null {
  if (!tx?.startsWith("0x")) return null;
  switch (chain.key) {
    case "arbitrum_sepolia":
      return `https://sepolia.arbiscan.io/tx/${tx}`;
    case "polygon_amoy":
      return `https://amoy.polygonscan.com/tx/${tx}`;
    default:
      return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchGatewayBalances(depositor: Hex): Promise<Array<{ domain: number; balance: number }>> {
  const body = {
    token: "USDC",
    sources: Object.values(TESTNET_CHAINS).map((chain) => ({
      domain: chain.domain,
      depositor,
    })),
  };
  const resp = await fetch(`${GATEWAY_TESTNET_API}/v1/balances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`gateway balances ${resp.status}: ${await resp.text()}`);
  }
  const payload: any = await resp.json();
  return (payload?.balances ?? []).map((item: any) => ({
    domain: Number(item.domain),
    balance: Number(item.balance ?? 0),
  }));
}

// Suppress unused-import lint while keeping the minter ABI exported in spirit
// (in case we want to flip off the forwarder later).
void gatewayMinterAbi;
