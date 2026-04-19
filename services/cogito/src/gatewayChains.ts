/**
 * Circle Gateway chain registry — testnet only for now.
 *
 * MERIDIAN's two-chain topology:
 *   - Arbitrum Sepolia (domain 3) — settlement / treasury / hook.
 *   - Polygon Amoy    (domain 7) — Polymarket CLOB trading EOAs.
 *
 * Mainnet Gateway support is intentionally NOT exported. Hackathon scope is
 * testnet-only; flipping to mainnet should be an explicit follow-up.
 *
 * USDC addresses pulled from Circle's testnet table:
 *   https://developers.circle.com/stablecoins/usdc-on-test-networks
 *
 * GatewayWallet + GatewayMinter share the same canonical address across all
 * EVM testnets (per the use-gateway skill reference).
 */
import { defineChain, type Chain, type Hex } from "viem";
import { arbitrumSepolia, polygonAmoy } from "viem/chains";

export const GATEWAY_TESTNET_API = "https://gateway-api-testnet.circle.com";

// Canonical EVM testnet Gateway contract addresses (same on every testnet).
export const EVM_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as Hex;
export const EVM_TESTNET_GATEWAY_MINTER = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B" as Hex;

export interface GatewayChain {
  /** Friendly key used on the wire from Python → cogito. */
  key: "arbitrum_sepolia" | "polygon_amoy";
  /** Circle CCTP/Gateway domain ID. */
  domain: number;
  /** EVM chain ID. */
  chainId: number;
  /** RPC URL — overridden via env when set (Alchemy/Infura/etc.). */
  rpcUrl: string;
  /** Native USDC contract on this chain. */
  usdc: Hex;
  /** Canonical GatewayWallet (deposit + balance source). */
  gatewayWallet: Hex;
  /** Canonical GatewayMinter (mint destination). */
  gatewayMinter: Hex;
  /** viem chain object for walletClient/publicClient. */
  viemChain: Chain;
}

const ARB_SEPOLIA_DEFAULT_RPC = "https://sepolia-rollup.arbitrum.io/rpc";
const POLYGON_AMOY_DEFAULT_RPC = "https://rpc-amoy.polygon.technology";

export const TESTNET_CHAINS: Record<GatewayChain["key"], GatewayChain> = {
  arbitrum_sepolia: {
    key: "arbitrum_sepolia",
    domain: 3,
    chainId: 421614,
    rpcUrl: process.env.ARB_SEPOLIA_RPC_URL ?? ARB_SEPOLIA_DEFAULT_RPC,
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as Hex,
    gatewayWallet: EVM_TESTNET_GATEWAY_WALLET,
    gatewayMinter: EVM_TESTNET_GATEWAY_MINTER,
    viemChain: arbitrumSepolia,
  },
  polygon_amoy: {
    key: "polygon_amoy",
    domain: 7,
    chainId: 80002,
    // viem ships polygonAmoy but its default RPC has rate-limited; allow override.
    rpcUrl:
      process.env.POLYGON_AMOY_RPC_URL ??
      polygonAmoy.rpcUrls?.default?.http?.[0] ??
      POLYGON_AMOY_DEFAULT_RPC,
    usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" as Hex,
    gatewayWallet: EVM_TESTNET_GATEWAY_WALLET,
    gatewayMinter: EVM_TESTNET_GATEWAY_MINTER,
    viemChain: polygonAmoy ?? defineChain({
      id: 80002,
      name: "Polygon Amoy",
      nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
      rpcUrls: { default: { http: [POLYGON_AMOY_DEFAULT_RPC] } },
    }),
  },
};

export function chainByKey(key: string): GatewayChain {
  const c = (TESTNET_CHAINS as Record<string, GatewayChain | undefined>)[key];
  if (!c) {
    throw new Error(
      `unknown chain key: ${key}. expected one of: ${Object.keys(TESTNET_CHAINS).join(", ")}`,
    );
  }
  return c;
}
