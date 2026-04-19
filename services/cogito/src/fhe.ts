/**
 * /fhe/encrypt — wraps cofhejs to mint real `InEuint128` sealed inputs.
 *
 * The Python execution-router can't call cofhejs directly (it's a TS/WASM lib),
 * so it POSTs `{ value, sender, utype }` here and gets back a JSON shape that
 * `services/execution_router/encryptor.py::SealedInput` parses 1:1 into the
 * Solidity `InEuint128` tuple consumed by `PrivateSettlementHook.fundBurner`
 * and `markResolved`.
 *
 * cofhejs is initialized once with an ethers v6 wallet on Arbitrum Sepolia
 * (Fhenix CoFHE testnet). The wallet address is the only valid `sender` for
 * the resulting sealed input — CoFHE binds the input to the signer that
 * proved it. We accept the caller's `sender` field but require it match the
 * configured FHE signer; otherwise the on-chain hook would revert.
 *
 * Wallet env priority:
 *   FHE_PRIVATE_KEY → TREASURY_PRIVATE_KEY (the latter already gates /bridge).
 * RPC env priority:
 *   FHE_RPC_URL → ARB_SEPOLIA_RPC_URL → ARBITRUM_SEPOLIA_RPC_URL → ZG_RPC_URL.
 *
 * Returns 503 when un-configured so the Python side stays on DryRunEncryptor.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { ethers } from "ethers";
import { cofhejs, Encryptable, FheTypes } from "cofhejs/node";

const FheBody = z.object({
  // Decimal uint128 string. The Python side serializes ints as `str(value)`.
  value: z.string().regex(/^\d+$/, "value must be a non-negative decimal integer"),
  // Caller hint: address that will submit the on-chain tx using this input.
  // Must match the cofhejs signer address (CoFHE binds inputs to the prover).
  sender: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  // Currently only Euint128. Kept for forward compatibility.
  utype: z.literal(FheTypes.Uint128).optional(),
  security_zone: z.number().int().min(0).optional(),
});

interface FheRoutes {
  router: Hono;
  /** True when an FHE signer + RPC are configured AND cofhejs init succeeded. */
  ready: boolean;
  /** Address of the cofhejs signer, or null when offline. */
  signer: string | null;
}

export function createFheRoutes(): FheRoutes {
  const router = new Hono();

  const rpcUrl =
    process.env.FHE_RPC_URL ??
    process.env.ARB_SEPOLIA_RPC_URL ??
    process.env.ARBITRUM_SEPOLIA_RPC_URL ??
    process.env.ZG_RPC_URL;
  const rawKey = process.env.FHE_PRIVATE_KEY ?? process.env.TREASURY_PRIVATE_KEY;

  if (!rpcUrl || !rawKey) {
    router.post("/encrypt", () => {
      throw new HTTPException(503, {
        message: "fhe not configured (need FHE_RPC_URL/ARB_SEPOLIA_RPC_URL + FHE_PRIVATE_KEY/TREASURY_PRIVATE_KEY)",
      });
    });
    return { router, ready: false, signer: null };
  }

  const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const signerAddress = wallet.address;

  // cofhejs is a singleton zustand store; init lazily on first request and
  // cache the promise so concurrent calls share one init.
  let initPromise: Promise<void> | null = null;
  async function ensureInitialized(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const result = await cofhejs.initializeWithEthers({
        ethersProvider: provider,
        ethersSigner: wallet,
        environment: "TESTNET",
      });
      if (!result.success) {
        initPromise = null; // allow retry on next call
        throw new HTTPException(500, { message: `cofhejs init failed: ${result.error}` });
      }
    })();
    return initPromise;
  }

  router.post("/encrypt", async (c) => {
    const parsed = FheBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.message });
    }
    const { value, sender, security_zone } = parsed.data;

    if (sender.toLowerCase() !== signerAddress.toLowerCase()) {
      throw new HTTPException(400, {
        message: `sender ${sender} does not match cogito FHE signer ${signerAddress}; on-chain hook would reject the proof`,
      });
    }

    await ensureInitialized();

    const item = Encryptable.uint128(BigInt(value));
    const encrypted =
      security_zone !== undefined
        ? await cofhejs.encrypt([item], security_zone)
        : await cofhejs.encrypt([item]);

    if (!encrypted.success) {
      throw new HTTPException(502, { message: `cofhejs encrypt failed: ${encrypted.error}` });
    }

    const sealed = encrypted.data[0];
    return c.json({
      // ctHash is a bigint — serialize as 0x-prefixed hex so the Python
      // SealedInput parser (which calls `int(x, 0)`) round-trips losslessly.
      ctHash: "0x" + sealed.ctHash.toString(16),
      securityZone: sealed.securityZone,
      utype: sealed.utype,
      signature: sealed.signature,
    });
  });

  return { router, ready: true, signer: signerAddress };
}
