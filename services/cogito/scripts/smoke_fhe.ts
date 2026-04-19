/**
 * Offline smoke for /fhe/encrypt. Runs the Hono router in-process (no network)
 * and confirms the 503 + 400 paths wire correctly. Skips the live cofhejs
 * encrypt — that path needs a funded Arb Sepolia wallet + CoFHE coprocessor.
 */
import { createFheRoutes } from "../src/fhe.ts";

const routes = createFheRoutes();
console.log("ready:", routes.ready, "signer:", routes.signer);

async function probe(label: string, body: unknown) {
  const res = await routes.router.request("/encrypt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(label, "→ status", res.status, "body", await res.text());
}

await probe("valid shape (offline)", { value: "1000", sender: "0x0000000000000000000000000000000000000001" });
await probe("bad body", {});
await probe("bad value", { value: "-1", sender: "0x0000000000000000000000000000000000000001" });
