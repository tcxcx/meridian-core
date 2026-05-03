/**
 * Thin wrapper around @0gfoundation/0g-ts-sdk for in-memory uploads.
 *
 * Pin policy: every payload is JSON-serialized, wrapped in a Blob, anchored
 * via Indexer.upload(), and identified by the merkle root. The signer pays
 * the (testnet) gas to register the root on-chain.
 */
import { Indexer, MemData } from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

export interface UploadResult {
  root_hash: string;
  tx_hash: string | null;
  size_bytes: number;
}

export interface ZgStatus {
  address: string;
  balance_wei: string;
  balance_og: string;
  gas_price_wei: string | null;
}

export class ZgFundingError extends Error {
  status: ZgStatus | null;

  constructor(message: string, status: ZgStatus | null = null) {
    super(message);
    this.name = "ZgFundingError";
    this.status = status;
  }
}

function isInsufficientFunds(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /insufficient funds|insufficient funds for transfer/i.test(message);
}

/**
 * Detect a contract-side revert from the 0G storage flow contract. The
 * Indexer / Uploader path can fail in two ways that look very different:
 *
 * 1. ethers v6 throws `insufficient funds` when the signer can't pay gas
 *    up-front. Caught by isInsufficientFunds() above.
 *
 * 2. The tx is mined but reverts with status:0 — typically because the
 *    signer didn't include enough native OG to cover the storage fee
 *    (see Uploader.js: it sends value=storageFee). ethers v6 surfaces
 *    this as `code: "CALL_EXCEPTION"` with `transaction execution
 *    reverted` and a non-null receipt with status: 0. The original
 *    isInsufficientFunds() never matched because the literal phrase
 *    "insufficient funds" doesn't appear in the revert message.
 *
 * This second case is what the user hits when the Galileo signer is
 * low on OG and the storage fee exceeds available balance. We treat
 * it as a funding issue and surface ZgFundingError with the same
 * actionable hint (faucet, refill).
 */
function isContractRevert(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: string; receipt?: { status?: number } };
  const message = error instanceof Error ? error.message : String(error);
  if (e.code === "CALL_EXCEPTION") return true;
  if (e.receipt && e.receipt.status === 0) return true;
  if (/transaction execution reverted/i.test(message)) return true;
  return false;
}

export class ZgClient {
  private signer: ethers.Wallet;
  private indexer: Indexer;
  private rpcUrl: string;

  constructor(opts: { rpcUrl: string; indexerUrl: string; privateKey: string }) {
    const provider = new ethers.JsonRpcProvider(opts.rpcUrl);
    this.signer = new ethers.Wallet(opts.privateKey, provider);
    this.indexer = new Indexer(opts.indexerUrl);
    this.rpcUrl = opts.rpcUrl;
  }

  get address(): string {
    return this.signer.address;
  }

  async status(): Promise<ZgStatus> {
    const balance = await this.signer.provider!.getBalance(this.signer.address);
    const fee = await this.signer.provider!.getFeeData().catch(() => null);
    const gasPrice = fee?.gasPrice ?? null;
    return {
      address: this.signer.address,
      balance_wei: balance.toString(),
      balance_og: ethers.formatEther(balance),
      gas_price_wei: gasPrice ? gasPrice.toString() : null,
    };
  }

  /** Upload a JSON-serialisable payload. Returns the merkle root (hex). */
  async upload(payload: unknown): Promise<UploadResult> {
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);
    const data = new MemData(bytes);

    const [tree, treeErr] = await data.merkleTree();
    if (treeErr || !tree) throw new Error(`merkleTree failed: ${treeErr}`);
    const rootHash = tree.rootHash();
    if (!rootHash) throw new Error("merkleTree returned empty root");

    const [tx, uploadErr] = await this.indexer.upload(data, this.rpcUrl, this.signer);
    if (uploadErr) {
      if (isInsufficientFunds(uploadErr) || isContractRevert(uploadErr)) {
        const status = await this.status().catch(() => null);
        const balanceHint = status ? ` (current balance: ${status.balance_og} OG)` : "";
        const cause = isInsufficientFunds(uploadErr)
          ? "insufficient gas to send the storage tx"
          : "storage contract reverted (typically because the signer can't cover the storage fee)";
        throw new ZgFundingError(
          `0G signer ${this.signer.address} could not pin to Galileo: ${cause}${balanceHint}. ` +
            `Refill at https://faucet.0g.ai (faucet may be intermittent — see LESSONS.md).`,
          status,
        );
      }
      throw new Error(`indexer.upload failed: ${uploadErr}`);
    }

    let txHash: string | null = null;
    if (tx) {
      if ("txHash" in tx && tx.txHash) txHash = tx.txHash;
      else if ("txHashes" in tx && tx.txHashes?.length) txHash = tx.txHashes[0];
    }

    return {
      root_hash: rootHash,
      tx_hash: txHash,
      size_bytes: bytes.byteLength,
    };
  }

  /** Download a payload by merkle root. Returns the raw bytes. */
  async download(rootHash: string, withProof = true): Promise<Uint8Array> {
    const dir = join(tmpdir(), `cogito-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const outPath = join(dir, "payload.json");
    try {
      const err = await this.indexer.download(rootHash, outPath, withProof);
      if (err) throw new Error(`indexer.download failed: ${err}`);
      const buf = await readFile(outPath);
      return new Uint8Array(buf);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
