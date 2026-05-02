/**
 * cogito — MERIDIAN's 0G anchor + inference sidecar.
 *
 * Hono on Bun. Bound to 127.0.0.1 by default. Bearer-token auth, body-size
 * cap, simple per-token rate limit. Wraps both 0G TS SDKs:
 *   - `@0gfoundation/0g-ts-sdk`     → Storage (pin/fetch JSON by merkle root)
 *   - `@0glabs/0g-serving-broker`   → Compute (DeAIOS verifiable LLM inference)
 *
 * Endpoints:
 *   GET  /health
 *   POST /upload                     pin a JSON payload
 *   GET  /download/:root_hash        fetch by merkle root
 *   GET  /compute/services           list 0G Compute providers
 *   GET  /compute/account            ledger snapshot
 *   POST /compute/account/setup      addLedger { amount }
 *   POST /compute/provider/ack       acknowledge { provider }
 *   POST /compute/provider/fund      transferFund { provider, amount }
 *   POST /compute/inference          OpenAI-style chat → verified response
 *
 * All routes except /health require `Authorization: Bearer <COGITO_TOKEN>`.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { logger } from "hono/logger";
import { z } from "zod";

import { ZgClient, ZgFundingError } from "./zg.js";
import { ComputeClient, TESTNET_PROVIDERS } from "./compute.js";
import { createBridgeRoutes } from "./bridge.js";
import { createFheRoutes } from "./fhe.js";

const REQUIRED_ENV = ["ZG_RPC_URL", "ZG_INDEXER_URL", "COGITO_TOKEN"] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`cogito: missing required env ${k}`);
    process.exit(2);
  }
}

const PORT = Number(process.env.COGITO_PORT ?? 5003);
const HOST = process.env.COGITO_HOST ?? "127.0.0.1";
const TOKEN = process.env.COGITO_TOKEN!;
const MAX_BODY_BYTES = Number(process.env.COGITO_MAX_BODY_BYTES ?? 1_048_576); // 1 MB
const RATE_LIMIT_PER_MIN = Number(process.env.COGITO_RATE_LIMIT_PER_MIN ?? 60);

const zgPrivateKey = process.env.ZG_PRIVATE_KEY?.trim();
const storageReady = !!zgPrivateKey;
const computeReady = !!zgPrivateKey;

const zg = storageReady
  ? new ZgClient({
      rpcUrl: process.env.ZG_RPC_URL!,
      indexerUrl: process.env.ZG_INDEXER_URL!,
      privateKey: zgPrivateKey!,
    })
  : null;

const compute = computeReady
  ? new ComputeClient({
      rpcUrl: process.env.ZG_RPC_URL!,
      privateKey: zgPrivateKey!,
    })
  : null;

if (zg) {
  console.log(`cogito: signer address ${zg.address}`);
} else {
  console.log("cogito: storage + compute offline (set ZG_PRIVATE_KEY to enable 0G routes)");
}

const bridgeRoutes = createBridgeRoutes();
console.log(`cogito: bridge route ${bridgeRoutes.ready ? "ready" : "offline (set TREASURY_PRIVATE_KEY)"}`);

const fheRoutes = createFheRoutes();
console.log(
  `cogito: fhe route ${fheRoutes.ready ? `ready (signer ${fheRoutes.signer})` : "offline (set FHE_PRIVATE_KEY/TREASURY_PRIVATE_KEY + FHE_RPC_URL/ARB_SEPOLIA_RPC_URL)"}`,
);

// ── middleware ────────────────────────────────────────────────────────────────

const app = new Hono();
app.use("*", logger());
app.use("*", secureHeaders());

function requireStorage(): ZgClient {
  if (!zg) {
    throw new HTTPException(503, { message: "0G storage offline (set ZG_PRIVATE_KEY)" });
  }
  return zg;
}

function requireCompute(): ComputeClient {
  if (!compute) {
    throw new HTTPException(503, { message: "0G compute offline (set ZG_PRIVATE_KEY)" });
  }
  return compute;
}

// constant-time bearer token check
function tokenMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next();
  const auth = c.req.header("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m || !tokenMatches(m[1], TOKEN)) {
    throw new HTTPException(401, { message: "unauthorized" });
  }
  return next();
});

// minimal in-memory token-bucket per token (we only have one token, so this
// caps total request rate — sufficient for a localhost sidecar)
const buckets = new Map<string, { count: number; resetAt: number }>();
app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next();
  const now = Date.now();
  const b = buckets.get(TOKEN) ?? { count: 0, resetAt: now + 60_000 };
  if (now > b.resetAt) {
    b.count = 0;
    b.resetAt = now + 60_000;
  }
  b.count += 1;
  buckets.set(TOKEN, b);
  if (b.count > RATE_LIMIT_PER_MIN) {
    throw new HTTPException(429, { message: "rate limited" });
  }
  return next();
});

app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: () => {
  throw new HTTPException(413, { message: "payload too large" });
}}));

// ── routes ────────────────────────────────────────────────────────────────────

app.get("/health", async (c) => {
  const bridgeStatus = await bridgeRoutes.status();
  const zgStatus = zg ? await zg.status().catch(() => null) : null;
  return c.json({
    service: "cogito",
    status: "ok",
    signer: zg?.address ?? null,
    rpc: process.env.ZG_RPC_URL,
    indexer: process.env.ZG_INDEXER_URL,
    capabilities: ["storage", "compute", "bridge", "fhe"],
    storage: {
      ok: storageReady,
      signer: zg?.address ?? null,
      balance_og: zgStatus?.balance_og ?? null,
      gas_price_wei: zgStatus?.gas_price_wei ?? null,
    },
    compute: {
      ok: computeReady,
      signer: compute?.address ?? null,
    },
    bridge: { ready: bridgeRoutes.ready },
    gateway: {
      ready: bridgeRoutes.ready,
      treasuryBalance: bridgeStatus.treasuryBalance,
      balances: bridgeStatus.balances,
      depositor: bridgeStatus.depositor,
    },
    fhe: { ready: fheRoutes.ready, signer: fheRoutes.signer, ...fheRoutes.status() },
    models: Object.keys(TESTNET_PROVIDERS),
  });
});

app.route("/bridge", bridgeRoutes.router);
app.route("/fhe", fheRoutes.router);

const UploadBody = z.object({
  kind: z.enum(["seed", "simulation", "other"]),
  payload: z.unknown(),
  meta: z.record(z.unknown()).optional(),
});

app.post("/upload", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = UploadBody.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, { message: parsed.error.message });
  }
  const { kind, payload, meta } = parsed.data;
  const wrapped = {
    schema: "meridian/cogito/v1",
    kind,
    pinned_at: new Date().toISOString(),
    meta: meta ?? {},
    payload,
  };
  let result;
  try {
    result = await requireStorage().upload(wrapped);
  } catch (error) {
    if (error instanceof ZgFundingError) {
      return c.json(
        {
          error: "0g_insufficient_funds",
          message: error.message,
          signer: error.status?.address ?? requireStorage().address,
          balance_og: error.status?.balance_og ?? null,
        },
        402,
      );
    }
    throw error;
  }
  return c.json({ ...result, kind });
});

app.get("/download/:root_hash", async (c) => {
  const root = c.req.param("root_hash");
  if (!/^0x[0-9a-fA-F]{2,}$/.test(root)) {
    throw new HTTPException(400, { message: "root_hash must be hex" });
  }
  const bytes = await requireStorage().download(root, true);
  // Bytes are already JSON — pass through as text so Python clients can re-parse.
  return new Response(new Blob([bytes as BlobPart]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

// ── compute (0G DeAIOS) ───────────────────────────────────────────────────────

app.get("/compute/services", async (c) => {
  const services = await requireCompute().listServices();
  return c.json({ count: services.length, services });
});

app.get("/compute/account", async (c) => {
  const client = requireCompute();
  const ledger = await client.getLedger();
  return c.json({ address: client.address, ledger });
});

const SetupBody = z.object({ amount: z.number().positive() });
app.post("/compute/account/setup", async (c) => {
  const parsed = SetupBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message });
  await requireCompute().addLedger(parsed.data.amount);
  return c.json({ ok: true, message: `addLedger(${parsed.data.amount}) ok` });
});

const AckBody = z.object({ provider: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });
app.post("/compute/provider/ack", async (c) => {
  const parsed = AckBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message });
  await requireCompute().ackProvider(parsed.data.provider);
  return c.json({ ok: true, provider: parsed.data.provider });
});

const FundBody = z.object({
  provider: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amount: z.number().positive(),
});
app.post("/compute/provider/fund", async (c) => {
  const parsed = FundBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message });
  await requireCompute().transferToProvider(parsed.data.provider, parsed.data.amount);
  return c.json({ ok: true, provider: parsed.data.provider, amount: parsed.data.amount });
});

const InferenceBody = z.object({
  provider: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  model: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
  })).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(8192).optional(),
});
app.post("/compute/inference", async (c) => {
  const parsed = InferenceBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message });
  const result = await requireCompute().inference(parsed.data);
  return c.json(result);
});

// ── error handler ─────────────────────────────────────────────────────────────

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error("cogito unhandled:", err);
  return c.json({ error: "internal" }, 500);
});

console.log(`cogito: listening on http://${HOST}:${PORT}`);
export default { port: PORT, hostname: HOST, fetch: app.fetch };
