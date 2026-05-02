import { AppKit } from '@circle-fin/app-kit'
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2'
import { createPublicClient, defineChain, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrumSepolia, baseSepolia, polygon, polygonAmoy } from 'viem/chains'

const ARC_TESTNET = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ['https://rpc-testnet.arc.gel.network'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Arcscan Testnet',
      url: 'https://testnet.arcscan.app',
    },
  },
  testnet: true,
})

const CHAIN_CONFIGS = {
  Polygon: {
    appKitChain: 'Polygon',
    viemChain: polygon,
    envKeys: ['POLYGON_RPC_URL', 'POLYGON_MAINNET_RPC_URL'],
    gatewayKey: 'polygon',
    explorerBaseUrl: 'https://polygonscan.com/tx/',
    swapSupported: true,
    modularSegment: '/polygon',
  },
  Polygon_Amoy_Testnet: {
    appKitChain: 'Polygon_Amoy_Testnet',
    viemChain: polygonAmoy,
    envKeys: ['POLYGON_AMOY_RPC_URL', 'POLYGON_RPC_URL'],
    gatewayKey: 'polygon_amoy',
    explorerBaseUrl: 'https://amoy.polygonscan.com/tx/',
    swapSupported: false,
    modularSegment: '/polygonAmoy',
  },
  Arc_Testnet: {
    appKitChain: 'Arc_Testnet',
    viemChain: ARC_TESTNET,
    envKeys: ['ARC_RPC_URL'],
    gatewayKey: null,
    explorerBaseUrl: 'https://testnet.arcscan.app/tx/',
    swapSupported: true,
    modularSegment: '/arcTestnet',
  },
  Arbitrum_Sepolia: {
    appKitChain: 'Arbitrum_Sepolia',
    viemChain: arbitrumSepolia,
    envKeys: ['ARB_SEPOLIA_RPC_URL', 'ARBITRUM_SEPOLIA_RPC_URL'],
    gatewayKey: 'arbitrum_sepolia',
    explorerBaseUrl: 'https://sepolia.arbiscan.io/tx/',
    swapSupported: false,
    modularSegment: '/arbitrumSepolia',
  },
  Base_Sepolia: {
    appKitChain: 'Base_Sepolia',
    viemChain: baseSepolia,
    envKeys: ['BASE_SEPOLIA_RPC_URL'],
    gatewayKey: 'base_sepolia',
    explorerBaseUrl: 'https://sepolia.basescan.org/tx/',
    swapSupported: false,
    modularSegment: '/baseSepolia',
  },
}

let APP_KIT = null

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim()) return value.trim()
  }
  return ''
}

function resolveKey(name) {
  const value = CHAIN_CONFIGS[name]
  if (!value) {
    throw new Error(`Unsupported Circle chain: ${name}`)
  }
  return value
}

export function getAppKit() {
  if (!APP_KIT) APP_KIT = new AppKit()
  return APP_KIT
}

export function getKitKey() {
  const value = envValue('CIRCLE_KIT_KEY')
  if (!value) {
    throw new Error('CIRCLE_KIT_KEY is required for Circle App Kit execution.')
  }
  return value
}

export function getExecutionPrivateKey() {
  const value = envValue('TRADING_WALLET_PRIVATE_KEY', 'GATEWAY_SIGNER_PRIVATE_KEY', 'TREASURY_PRIVATE_KEY')
  if (!value) {
    throw new Error(
      'A signing key is required for Circle execution. Set TRADING_WALLET_PRIVATE_KEY, GATEWAY_SIGNER_PRIVATE_KEY, or TREASURY_PRIVATE_KEY.',
    )
  }
  return value
}

export function getExecutionSignerAddress() {
  return privateKeyToAccount(getExecutionPrivateKey()).address
}

export function resolveSendChainName() {
  const explicit = envValue('MIROSHARK_SEND_CHAIN')
  if (explicit) return explicit
  return String(process.env.POLYMARKET_CHAIN_ID || '80002') === '137' ? 'Polygon' : 'Polygon_Amoy_Testnet'
}

export function resolveSwapChainName() {
  const explicit = envValue('MIROSHARK_SWAP_CHAIN')
  if (explicit) return explicit
  return 'Polygon'
}

export function resolveChainConfig(name) {
  return resolveKey(name)
}

export function resolveSendChainConfig() {
  return resolveKey(resolveSendChainName())
}

export function resolveSwapChainConfig() {
  return resolveKey(resolveSwapChainName())
}

function rpcUrlForChainId(chainId) {
  if (chainId === polygon.id) return envValue('POLYGON_RPC_URL', 'POLYGON_MAINNET_RPC_URL')
  if (chainId === polygonAmoy.id) return envValue('POLYGON_AMOY_RPC_URL', 'POLYGON_RPC_URL')
  if (chainId === arbitrumSepolia.id) return envValue('ARB_SEPOLIA_RPC_URL', 'ARBITRUM_SEPOLIA_RPC_URL')
  if (chainId === baseSepolia.id) return envValue('BASE_SEPOLIA_RPC_URL')
  if (chainId === ARC_TESTNET.id) return envValue('ARC_RPC_URL') || 'https://rpc-testnet.arc.gel.network'
  return envValue('RPC_URL')
}

export function createAdapterForExecution() {
  const privateKey = getExecutionPrivateKey()
  const account = privateKeyToAccount(privateKey)
  const adapter = createViemAdapterFromPrivateKey({
    privateKey,
    getPublicClient: ({ chain }) => {
      const rpcUrl = rpcUrlForChainId(chain.id)
      if (!rpcUrl) {
        throw new Error(`No RPC URL configured for chain ${chain.name} (${chain.id}).`)
      }
      return createPublicClient({
        chain,
        transport: http(rpcUrl, { retryCount: 2, timeout: 15_000 }),
      })
    },
  })

  return { adapter, signerAddress: account.address }
}

export function summarizeSend(step) {
  return {
    state: String(step?.state || 'unknown'),
    txHash: step?.txHash || null,
    explorerUrl: step?.explorerUrl || null,
    steps: [
      {
        name: step?.name || 'send',
        state: String(step?.state || 'unknown'),
        txHash: step?.txHash || null,
        explorerUrl: step?.explorerUrl || null,
      },
    ],
  }
}

export function summarizeSwap(result) {
  return {
    state: 'success',
    txHash: result?.txHash || null,
    explorerUrl: result?.explorerUrl || null,
    amountOut: result?.amountOut || null,
    fees: Array.isArray(result?.fees) ? result.fees : [],
  }
}

export function buildExplorerUrl(chainName, txHash) {
  if (!txHash) return null
  const config = CHAIN_CONFIGS[chainName]
  if (!config?.explorerBaseUrl) return null
  return `${config.explorerBaseUrl}${txHash}`
}

export function canUseSwapChain(config) {
  return Boolean(config?.swapSupported)
}
