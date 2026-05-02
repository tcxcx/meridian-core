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
import { createCredential, parsePublicKey, serializePublicKey, sign as signWebAuthn } from 'webauthn-p256'

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

function toCircleUsername(label, fallback = 'Miroshark_Treasury', options = {}) {
  const normalized = String(label || fallback)
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_@.:+-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  let username = normalized || fallback
  if (options.unique) {
    const suffix = `_${Date.now().toString(36)}`
    username = `${username.slice(0, Math.max(5, 50 - suffix.length))}${suffix}`
  }
  if (username.length < 5) return fallback
  if (username.length > 50) return username.slice(0, 50).replace(/^_+|_+$/g, '') || fallback
  return username
}

function resolveEffectiveCircleChainName(clientKey, requestedChainName) {
  if (String(clientKey || '').startsWith('TEST_CLIENT_KEY:') && requestedChainName === 'Polygon') {
    return 'Polygon_Amoy_Testnet'
  }
  return requestedChainName
}

function resolveBrowserRpId() {
  if (typeof window === 'undefined') return 'localhost'
  return window.location.hostname === '127.0.0.1' ? 'localhost' : window.location.hostname
}

function toLocalWebAuthnOwner(credential, rpId = resolveBrowserRpId()) {
  if (!credential?.id) {
    throw new Error('Passkey credential is missing an id.')
  }
  if (!credential?.publicKey) {
    throw new Error('Passkey credential is missing a public key. Use a platform passkey that exposes P-256 public keys.')
  }
  const publicKey = normalizeP256PublicKey(credential.publicKey)
  return {
    ...credential,
    publicKey,
    rpId,
    type: 'webAuthn',
    sign: async ({ hash }) => signWebAuthn({
      credentialId: credential.id,
      hash,
      rpId,
    }),
  }
}

function normalizeP256PublicKey(publicKey) {
  const parsed = parsePublicKey(publicKey)
  return serializePublicKey(parsed, { compressed: false })
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

function errorMessage(error) {
  if (!error) return ''
  const parts = [
    error.message,
    error.shortMessage,
    error.details,
    error.cause?.message,
    error.cause?.details,
  ]
  return parts.filter(Boolean).join(' ').toLowerCase()
}

function isAlreadyExistsError(error) {
  const message = errorMessage(error)
  return message.includes('already exists') || message.includes('already exist')
}

function isExecutionRevertError(error) {
  const message = errorMessage(error)
  return message.includes('execution reverted') || message.includes('reverted for an unknown reason')
}

async function registerOwnerAddressMapping(publicClient, account, credential) {
  const rawPublicKey = credential?.publicKey
  if (!rawPublicKey) return []
  const parsed = parsePublicKey(rawPublicKey)
  try {
    return await createAddressMapping(publicClient, {
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
  } catch (error) {
    if (isAlreadyExistsError(error)) return []
    throw error
  }
}

async function installAgentWalletRegistry({ account, bundlerClient, recipients }) {
  if (!recipients?.length) {
    throw new Error(
      'No agent trading wallet address is available for registry installation. Set TRADING_WALLET_PRIVATE_KEY, GATEWAY_SIGNER_PRIVATE_KEY, TRADING_WALLET_ADDRESS, or MIROSHARK_AGENT_WALLET_ADDRESS.',
    )
  }
  try {
    const hash = await bundlerClient.sendUserOperation({
      account,
      callData: encodeInstallAddressBook(recipients),
      paymaster: true,
    })
    await bundlerClient.waitForUserOperationReceipt({ hash, timeout: 120_000 })
    return { addressBookInstalled: true, userOpHash: hash, registryError: null }
  } catch (error) {
    if (isAlreadyExistsError(error) || isExecutionRevertError(error)) {
      return {
        addressBookInstalled: false,
        userOpHash: null,
        registryError: error instanceof Error ? error.message : String(error),
      }
    }
    throw error
  }
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

export async function loginTreasuryCredential({ label, credentialId, publicKey, rpId } = {}) {
  if (credentialId && publicKey) {
    return toLocalWebAuthnOwner({ id: credentialId, publicKey }, rpId || resolveBrowserRpId())
  }

  const config = getModularWalletConfig()
  const passkeyTransport = toPasskeyTransport(config.clientUrl, config.clientKey)
  const credential = await toWebAuthnCredential({
    transport: passkeyTransport,
    mode: WebAuthnMode.Login,
    username: toCircleUsername(label),
  })
  return toLocalWebAuthnOwner(credential, credential.rpId || resolveBrowserRpId())
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
  const credentialUsername = toCircleUsername(label, 'Miroshark_Treasury', { unique: true })
  const credential = await registerTreasuryCredential({ label: credentialUsername })
  const connected = await connectTreasurySmartAccount({
    credential,
    walletAddress: null,
    label: credentialUsername,
    recoveryAddress,
    agentWalletAddress,
  })

  return {
    ...connected,
    publicKey: credential.publicKey,
    credentialId: credential.id,
    credentialUsername,
  }
}

export async function registerTreasuryCredential({ label } = {}) {
  const username = toCircleUsername(label)
  const rpId = resolveBrowserRpId()
  const credential = await createCredential({
    name: username,
    rp: {
      id: rpId,
      name: 'Miroshark Treasury',
    },
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      requireResidentKey: false,
      userVerification: 'required',
    },
  })
  return toLocalWebAuthnOwner(credential, rpId)
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
    name: toCircleUsername(label),
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
  const { addressBookInstalled, userOpHash, registryError } = walletAddress
    ? { addressBookInstalled: false, userOpHash: null, registryError: null }
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
    registryError,
  }
}
