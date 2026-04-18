/**
 * 0G Compute (DeAIOS) bridge.
 *
 * Same wallet as the Storage path — funded on 0G Galileo testnet pays
 * micropayments for verifiable LLM inference. The signer must:
 *   1. addLedger(>= 3 OG)              once
 *   2. acknowledgeProviderSigner(p)    once per provider
 *   3. transferFund(p, >= 1 OG)        once per provider
 *
 * Then `inference()` is callable per-query.
 */
import { ethers } from "ethers";
import {
  createZGComputeNetworkBroker,
  type ZGComputeNetworkBroker,
} from "@0glabs/0g-serving-broker";
import OpenAI from "openai";

// Official 0G Galileo testnet providers (from starter-kit README, 2026-04).
export const TESTNET_PROVIDERS: Record<string, string> = {
  "qwen/qwen-2.5-7b-instruct": "0xa48f01287233509FD694a22Bf840225062E67836",
  "openai/gpt-oss-20b": "0x8e60d466FD16798Bec4868aa4CE38586D5590049",
  "google/gemma-3-27b-it": "0x69Eb5a0BD7d0f4bF39eD5CE9Bd3376c61863aE08",
};

const DEFAULT_MODEL = "openai/gpt-oss-20b";

export interface InferenceRequest {
  /** Provider EVM address. Wins over `model` if both are given. */
  provider?: string;
  /** Logical model name; resolved against TESTNET_PROVIDERS. */
  model?: string;
  /** OpenAI-style chat messages. */
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  /** Optional override for max tokens, etc. */
  temperature?: number;
  max_tokens?: number;
}

export interface InferenceResult {
  content: string;
  model: string;
  provider: string;
  chat_id: string;
  valid: boolean | null;
  prompt_chars: number;
  response_chars: number;
}

export class ComputeClient {
  private signer: ethers.Wallet;
  private brokerPromise: Promise<ZGComputeNetworkBroker>;
  private acked = new Set<string>();

  constructor(opts: { rpcUrl: string; privateKey: string }) {
    const provider = new ethers.JsonRpcProvider(opts.rpcUrl);
    this.signer = new ethers.Wallet(opts.privateKey, provider);
    this.brokerPromise = createZGComputeNetworkBroker(this.signer);
  }

  get address(): string {
    return this.signer.address;
  }

  private async broker(): Promise<ZGComputeNetworkBroker> {
    return this.brokerPromise;
  }

  /** List on-chain registered services with model/price metadata. */
  async listServices(): Promise<unknown[]> {
    const b = await this.broker();
    const services = await b.inference.listService();
    return services.map((s: any) => ({
      provider: s.provider,
      model: s.model,
      service_type: s.serviceType,
      url: s.url,
      input_price_wei: s.inputPrice?.toString?.() ?? null,
      output_price_wei: s.outputPrice?.toString?.() ?? null,
      verifiability: s.verifiability,
      is_official: Object.values(TESTNET_PROVIDERS).includes(s.provider),
    }));
  }

  /** Ledger snapshot — BigInts stringified. */
  async getLedger(): Promise<unknown> {
    const b = await this.broker();
    const info = await b.ledger.getLedger();
    return JSON.parse(JSON.stringify(info, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  }

  async addLedger(amountOg: number): Promise<void> {
    const b = await this.broker();
    await b.ledger.addLedger(amountOg);
  }

  async ackProvider(providerAddress: string): Promise<void> {
    const b = await this.broker();
    await b.inference.acknowledgeProviderSigner(providerAddress);
    this.acked.add(providerAddress.toLowerCase());
  }

  async transferToProvider(providerAddress: string, amountOg: number): Promise<void> {
    const b = await this.broker();
    const wei = ethers.parseEther(amountOg.toString());
    await b.ledger.transferFund(providerAddress, "inference", wei);
  }

  /** Resolve a logical model name to a provider address. */
  resolveProvider(req: InferenceRequest): string {
    if (req.provider) return req.provider;
    const model = req.model ?? DEFAULT_MODEL;
    const addr = TESTNET_PROVIDERS[model];
    if (!addr) throw new Error(`unknown model "${model}" — pass provider explicitly`);
    return addr;
  }

  /**
   * Run a chat completion against a 0G Compute provider.
   *
   * Idempotency: acknowledgement is best-effort (silently swallowed if the
   * SDK reports "already acknowledged"). Funding/ledger setup must be done
   * out-of-band via `/compute/account/setup` + `/compute/provider/fund`.
   */
  async inference(req: InferenceRequest): Promise<InferenceResult> {
    const provider = this.resolveProvider(req);
    const b = await this.broker();

    // Ack on first use this process — cached after.
    if (!this.acked.has(provider.toLowerCase())) {
      try {
        await b.inference.acknowledgeProviderSigner(provider);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (!/already/i.test(msg)) throw e;
      }
      this.acked.add(provider.toLowerCase());
    }

    const { endpoint, model } = await b.inference.getServiceMetadata(provider);

    // Single-use auth headers per query (replay-prevention).
    const promptText = req.messages.map((m) => m.content).join("\n");
    const headers = await b.inference.getRequestHeaders(provider, promptText);
    const headerMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === "string") headerMap[k] = v;
    }

    const openai = new OpenAI({ baseURL: endpoint, apiKey: "" });
    const completion = await openai.chat.completions.create(
      {
        model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
      },
      { headers: headerMap },
    );

    const content = completion.choices[0]?.message?.content ?? "";
    const chatId = completion.id;

    let valid: boolean | null = null;
    try {
      valid = await b.inference.processResponse(provider, chatId, content);
    } catch (e: any) {
      // Don't fail the request if settlement glitches — surface as valid:null.
      console.warn(`compute: processResponse warn (${chatId}): ${e?.message ?? e}`);
    }

    return {
      content,
      model,
      provider,
      chat_id: chatId,
      valid,
      prompt_chars: promptText.length,
      response_chars: content.length,
    };
  }
}
