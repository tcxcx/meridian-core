'use client'

import {
  createAddressMapping,
  OwnerIdentifierType,
  WebAuthnMode,
  recoveryActions,
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
} from '@circle-fin/modular-wallets-core'
import { createPublicClient } from 'viem'
import { createBundlerClient } from 'viem/account-abstraction'
import { encodeAbiParameters, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrumSepolia, baseSepolia, polygon, polygonAmoy } from 'viem/chains'
import { parsePublicKey } from 'webauthn-p256'

const ADDRESS_BOOK_MODULE_ADDRESS = '0x0000000d81083B16EA76dfab46B0315B0eDBF3d0'
const ADDRESS_BOOK_MANIFEST_HASH =
  '0x9d177c1c9573b10436b693b7a49f0face36b677c1606a2c579bba1415be349d8'
const WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN_ADDRESS =
  '0x0000000C984AFf541D6cE86Bb697e68ec57873C8'
const WEIGHTED_WEB_AUTHN_MULTISIG_OWNER_FUNCTION_ID = 0
const INSTALL_PLUGIN_ABI = [
  {
    type: 'function',
    name: 'installPlugin',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'plugin', type: 'address' },
      { name: 'manifestHash', type: 'bytes32' },
      { name: 'pluginInstallData', type: 'bytes' },
      {
        name: 'dependencies',
        type: 'tuple[]',
        components: [
          { name: 'plugin', type: 'address' },
          { name: 'functionId', type: 'uint8' },
        ],
      },
    ],
  },
]

const CHAIN_CONFIGS = {
  Polygon: {
    appKitChain: 'Polygon',
    chain: polygon,
    transportSegment: '/polygon',
  },
  Polygon_Amoy_Testnet: {
    appKitChain: 'Polygon_Amoy_Testnet',
    chain: polygonAmoy,
    transportSegment: '/polygonAmoy',
  },
  Arbitrum_Sepolia: {
    appKitChain: 'Arbitrum_Sepolia',
    chain: arbitrumSepolia,
    transportSegment: '/arbitrumSepolia',
  },
  Base_Sepolia: {
    appKitChain: 'Base_Sepolia',
    chain: baseSepolia,
    transportSegment: '/baseSepolia',
  },
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim()) return value.trim()
  }
  return ''
}

function getPublicCircleClientKey() {
  return (
    process.env.NEXT_PUBLIC_CIRCLE_MODULAR_CLIENT_KEY ||
    process.env.NEXT_PUBLIC_CIRCLE_CLIENT_KEY ||
    ''
  ).trim()
}

function getPublicCircleClientUrl() {
  return (
    process.env.NEXT_PUBLIC_CIRCLE_MODULAR_CLIENT_URL ||
    process.env.NEXT_PUBLIC_CIRCLE_CLIENT_URL ||
    ''
  ).trim()
}

function getPublicCircleChainName() {
  return (
    process.env.NEXT_PUBLIC_CIRCLE_MODULAR_CHAIN ||
    (String(process.env.NEXT_PUBLIC_POLYMARKET_CHAIN_ID || process.env.POLYMARKET_CHAIN_ID || '80002') === '137'
      ? 'Polygon'
      : 'Polygon_Amoy_Testnet')
  ).trim()
}

function resolveEffectiveCircleChainName(clientKey, requestedChainName) {
  if (String(clientKey || '').startsWith('TEST_CLIENT_KEY:') && requestedChainName === 'Polygon') {
    return 'Polygon_Amoy_Testnet'
  }
  return requestedChainName
}

function getAddressBookDependencies() {
  return [
    {
      plugin: WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN_ADDRESS,
      functionId: WEIGHTED_WEB_AUTHN_MULTISIG_OWNER_FUNCTION_ID,
    },
    {
      plugin: WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN_ADDRESS,
      functionId: WEIGHTED_WEB_AUTHN_MULTISIG_OWNER_FUNCTION_ID,
    },
  ]
}

function buildAddressBookInstallData(initialRecipients) {
  if (!initialRecipients?.length) return '0x'
  const recipients = [...new Set(initialRecipients.map((item) => String(item).toLowerCase()))]
  return encodeAbiParameters([{ type: 'address[]' }], [recipients])
}

function encodeInstallAddressBook(initialRecipients) {
  return encodeFunctionData({
    abi: INSTALL_PLUGIN_ABI,
    functionName: 'installPlugin',
    args: [
      ADDRESS_BOOK_MODULE_ADDRESS,
      ADDRESS_BOOK_MANIFEST_HASH,
      buildAddressBookInstallData(initialRecipients),
      getAddressBookDependencies(),
    ],
  })
}

function resolveAgentWalletRecipients(explicitRecipients = []) {
  const recipients = []
  for (const item of explicitRecipients) {
    if (item && String(item).trim()) recipients.push(String(item).trim())
  }
  const signerKey = envValue('TRADING_WALLET_PRIVATE_KEY', 'GATEWAY_SIGNER_PRIVATE_KEY')
  if (signerKey) {
    try {
      recipients.push(privateKeyToAccount(signerKey).address)
    } catch {
      // fall back to explicit recipients when the signer is unavailable client-side
    }
  }
  const explicit = envValue('TRADING_WALLET_ADDRESS', 'MIROSHARK_AGENT_WALLET_ADDRESS')
  if (explicit) recipients.push(explicit)
  return [...new Set(recipients.map((item) => String(item).toLowerCase()))]
}

async function registerOwnerAddressMapping(publicClient, account, credential) {
  const rawPublicKey = credential?.publicKey
  if (!rawPublicKey) return []
  const parsed = parsePublicKey(rawPublicKey)
  return createAddressMapping(publicClient, {
    walletAddress: account.address,
    owners: [
      {
        type: OwnerIdentifierType.WebAuthn,
        identifier: {
          publicKeyX: parsed.x.toString(),
          publicKeyY: parsed.y.toString(),
        },
      },
    ],
  })
}

async function installAgentWalletRegistry({ account, bundlerClient, recipients }) {
  if (!recipients?.length) {
    throw new Error(
      'No agent trading wallet address is available for registry installation. Set TRADING_WALLET_PRIVATE_KEY, GATEWAY_SIGNER_PRIVATE_KEY, TRADING_WALLET_ADDRESS, or MIROSHARK_AGENT_WALLET_ADDRESS.',
    )
  }
  const hash = await bundlerClient.sendUserOperation({
    account,
    callData: encodeInstallAddressBook(recipients),
    paymaster: true,
  })
  await bundlerClient.waitForUserOperationReceipt({ hash, timeout: 120_000 })
  return { addressBookInstalled: true, userOpHash: hash }
}

export function getModularWalletConfig() {
  const clientKey = getPublicCircleClientKey()
  const clientUrl = getPublicCircleClientUrl()
  const requestedChainName = getPublicCircleChainName()
  const chainName = resolveEffectiveCircleChainName(clientKey, requestedChainName)

  const chainConfig = CHAIN_CONFIGS[chainName]
  if (!clientKey || !clientUrl) {
    throw new Error('NEXT_PUBLIC_CIRCLE_MODULAR_CLIENT_KEY and NEXT_PUBLIC_CIRCLE_MODULAR_CLIENT_URL are required.')
  }
  if (!chainConfig) {
    throw new Error(`Unsupported modular wallet chain: ${chainName}`)
  }

  return {
    clientKey,
    clientUrl,
    requestedChainName,
    chainName,
    ...chainConfig,
  }
}

export async function loginTreasuryCredential({ label } = {}) {
  const config = getModularWalletConfig()
  const passkeyTransport = toPasskeyTransport(config.clientUrl, config.clientKey)
  return toWebAuthnCredential({
    transport: passkeyTransport,
    mode: WebAuthnMode.Login,
    username: label || 'Miroshark Treasury',
  })
}

function getUserOpFeeFloor(chainId, maxFeePerGas, maxPriorityFeePerGas) {
  if (chainId !== 5042002 || maxPriorityFeePerGas >= 1_000_000_000n) {
    return { maxFeePerGas, maxPriorityFeePerGas }
  }
  const delta = 1_000_000_000n - maxPriorityFeePerGas
  return {
    maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: maxFeePerGas + delta,
  }
}

export async function createTreasurySmartAccount({ label, recoveryAddress, agentWalletAddress } = {}) {
  const config = getModularWalletConfig()
  const credential = await registerTreasuryCredential({ label })
  const connected = await connectTreasurySmartAccount({
    credential,
    walletAddress: null,
    label,
    recoveryAddress,
    agentWalletAddress,
  })

  return {
    ...connected,
    publicKey: credential.publicKey,
    credentialId: credential.id,
  }
}

export async function registerTreasuryCredential({ label } = {}) {
  const config = getModularWalletConfig()
  const passkeyTransport = toPasskeyTransport(config.clientUrl, config.clientKey)
  return toWebAuthnCredential({
    transport: passkeyTransport,
    mode: WebAuthnMode.Register,
    username: label || 'Miroshark Treasury',
  })
}

export async function connectTreasurySmartAccount({ credential, walletAddress, label, recoveryAddress, agentWalletAddress } = {}) {
  const config = getModularWalletConfig()
  const modularTransport = toModularTransport(
    `${config.clientUrl}${config.transportSegment}`,
    config.clientKey,
  )

  const publicClient = createPublicClient({
    chain: config.chain,
    transport: modularTransport,
  })

  const account = await toCircleSmartAccount({
    ...(walletAddress ? { address: walletAddress } : {}),
    client: publicClient,
    owner: credential,
    name: label || 'Miroshark Treasury',
  })

  let recoveryRegistered = false
  if (recoveryAddress) {
    const bundlerClient = createBundlerClient({
      chain: config.chain,
      transport: modularTransport,
      userOperation: {
        estimateFeesPerGas: async () => {
          const estimated = await publicClient.estimateFeesPerGas({
            chain: config.chain,
            type: 'eip1559',
          })
          return getUserOpFeeFloor(
            config.chain.id,
            estimated.maxFeePerGas * 2n,
            estimated.maxPriorityFeePerGas * 2n,
          )
        },
      },
    }).extend(recoveryActions)

    await bundlerClient.registerRecoveryAddress({
      account,
      recoveryAddress,
      paymaster: true,
    })
    recoveryRegistered = true
  }

  const addressMappings = walletAddress ? [] : await registerOwnerAddressMapping(publicClient, account, credential)
  const registeredRecipients = walletAddress
    ? []
    : resolveAgentWalletRecipients(agentWalletAddress ? [agentWalletAddress] : [])
  const { addressBookInstalled, userOpHash } = walletAddress
    ? { addressBookInstalled: false, userOpHash: null }
    : await installAgentWalletRegistry({
        account,
        bundlerClient: createBundlerClient({
          chain: config.chain,
          transport: modularTransport,
          paymaster: true,
          userOperation: {
            estimateFeesPerGas: async () => {
              const estimated = await publicClient.estimateFeesPerGas({
                chain: config.chain,
                type: 'eip1559',
              })
              return getUserOpFeeFloor(
                config.chain.id,
                estimated.maxFeePerGas * 2n,
                estimated.maxPriorityFeePerGas * 2n,
              )
            },
          },
        }),
        recipients: registeredRecipients,
      })

  return {
    walletAddress: account.address,
    chain: config.appKitChain,
    chainId: config.chain.id,
    transportSegment: config.transportSegment,
    recoveryRegistered,
    addressBookInstalled,
    registeredRecipients,
    addressMappings,
    userOpHash,
  }
}
