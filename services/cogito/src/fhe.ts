/**
 * /fhe/encrypt — mints real `InEuint128` sealed inputs for the settlement hook.
 *
 * This route used to rely on the older `cofhejs` singleton path. Fhenix's
 * current supported server-side flow is `@cofhe/sdk`, which exposes:
 *
 *   createCofheConfig({ supportedChains: [arbSepolia] })
 *   createCofheClient(config)
 *   client.connect(publicClient, walletClient)
 *   client.encryptInputs([Encryptable.uint128(value)]).execute()
 *
 * The Python execution-router POSTs `{ value, sender }` here and receives a
 * JSON shape that `encryptor.py::SealedInput` parses 1:1 into Solidity's
 * `InEuint128` tuple consumed by `PrivateSettlementHook.fundBurner` and
 * `markResolved`.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { arbSepolia } from "@cofhe/sdk/chains";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

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
  /** True when an FHE signer + RPC are configured. */
  ready: boolean;
  /** Address of the cofhejs signer, or null when offline. */
  signer: string | null;
  status: () => {
    configured: boolean;
    live: boolean;
    engine: string;
    lastError: string | null;
  };
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
    return {
      router,
      ready: false,
      signer: null,
      status: () => ({ configured: false, live: false, engine: "@cofhe/sdk", lastError: "not configured" }),
    };
  }

  const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport });
  const walletClient = createWalletClient({ chain: arbitrumSepolia, transport, account });
  const signerAddress = account.address;
  let lastError: string | null = null;
  let live = false;
  const config = createCofheConfig({ supportedChains: [arbSepolia] });
  const client = createCofheClient(config);

  // Connect lazily on first request and share the promise across concurrent calls.
  let initPromise: Promise<void> | null = null;
  async function ensureConnected(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        await client.connect(
          publicClient as unknown as Parameters<typeof client.connect>[0],
          walletClient as unknown as Parameters<typeof client.connect>[1],
        );
      } catch (error) {
        initPromise = null; // allow retry on next call
        live = false;
        lastError = String(error);
        throw new HTTPException(500, { message: `cofhe sdk connect failed: ${error}` });
      }
      lastError = null;
    })();
    return initPromise;
  }

  async function warmup(): Promise<void> {
    try {
      await ensureConnected();
      const probe = await client.encryptInputs([Encryptable.uint128(1n)]).execute();
      if (!probe[0]) {
        throw new Error("cofhe sdk warmup returned an empty encryption result");
      }
      live = true;
      lastError = null;
    } catch (error) {
      live = false;
      lastError = String(error);
    }
  }

  // Warm the route once on boot so /health reflects actual encrypt readiness.
  void warmup();

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

    await ensureConnected();

    try {
      const item =
        security_zone !== undefined
          ? Encryptable.uint128(BigInt(value), security_zone)
          : Encryptable.uint128(BigInt(value));
      const encrypted = await client.encryptInputs([item]).execute();
      const sealed = encrypted[0];
      if (!sealed) {
        throw new Error("cofhe sdk returned an empty encryption result");
      }
      live = true;
      lastError = null;

      return c.json({
        ctHash: "0x" + sealed.ctHash.toString(16),
        securityZone: sealed.securityZone,
        utype: sealed.utype,
        signature: sealed.signature,
      });
    } catch (error) {
      live = false;
      lastError = String(error);
      throw new HTTPException(502, { message: `cofhe sdk encrypt failed: ${error}` });
    }
  });

  return {
    router,
    ready: true,
    signer: signerAddress,
    status: () => ({ configured: true, live, engine: "@cofhe/sdk", lastError }),
  };
}
