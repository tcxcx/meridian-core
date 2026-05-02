#!/usr/bin/env node
// Seed the Pinata connector state for the local operator session by POSTing to
// /api/pinata/connect with values from .env.local. Run this once after a fresh
// dev server boot so the LOOP-card Autonomous toggle and header status pill
// pick up the deployed agent immediately.
//
// Usage:
//   bun run --cwd apps/app scripts/seed-pinata-state.mjs
//   # or:
//   PINATA_AGENT_ID=xxx PINATA_AGENT_CHAT_URL=https://… node scripts/seed-pinata-state.mjs
//
// In local dev (Clerk disabled) this hits the route as the synthetic
// `local-owner` user. With Clerk enabled, sign in first and pass a session
// cookie via APP_COOKIE env var.

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const APP_DIR = process.cwd().endsWith('apps/app')
  ? process.cwd()
  : path.join(process.cwd(), 'apps/app')
const ENV_PATH = path.join(APP_DIR, '.env.local')

function loadEnv(file) {
  if (!existsSync(file)) return {}
  const raw = readFileSync(file, 'utf-8')
  const env = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
    env[key] = value
  }
  return env
}

function val(env, key) {
  return process.env[key] || env[key] || ''
}

async function main() {
  const env = loadEnv(ENV_PATH)
  const appUrl = val(env, 'NEXT_PUBLIC_APP_URL') || val(env, 'MIROSHARK_APP_URL') || 'http://localhost:3301'
  const body = {
    agentId: val(env, 'PINATA_AGENT_ID'),
    agentChatUrl: val(env, 'PINATA_AGENT_CHAT_URL'),
    agentTemplate: val(env, 'PINATA_AGENT_TEMPLATE') || 'prediction-market-trader',
    telegramHandle: val(env, 'PINATA_TELEGRAM_HANDLE'),
    onrampAgentId: val(env, 'PINATA_ONRAMP_AGENT_ID') || val(env, 'PINATA_AGENT_ID'),
    onrampChatUrl: val(env, 'PINATA_ONRAMP_CHAT_URL') || val(env, 'PINATA_AGENT_CHAT_URL'),
    operatorName: val(env, 'MIROSHARK_OWNER_NAME') || 'MiroShark Operator',
    notes: 'seeded from apps/app/.env.local via scripts/seed-pinata-state.mjs',
  }

  if (!body.agentId || !body.agentChatUrl) {
    console.error('Missing PINATA_AGENT_ID or PINATA_AGENT_CHAT_URL in env. Edit apps/app/.env.local first.')
    process.exit(1)
  }

  const url = `${appUrl.replace(/\/$/, '')}/api/pinata/connect`
  console.log(`POST ${url}`)
  console.log('  agentId      :', body.agentId)
  console.log('  agentChatUrl :', body.agentChatUrl)
  console.log('  template     :', body.agentTemplate)
  console.log('  telegram     :', body.telegramHandle || '(none)')

  const headers = { 'Content-Type': 'application/json' }
  const cookie = process.env.APP_COOKIE
  if (cookie) headers.Cookie = cookie

  let resp
  try {
    resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch (e) {
    console.error('fetch failed:', e.message)
    console.error('Is the dev server running? Try: bun run --cwd apps/app dev')
    process.exit(2)
  }

  const text = await resp.text()
  let payload
  try { payload = JSON.parse(text) } catch { payload = { raw: text } }

  if (!resp.ok) {
    console.error(`HTTP ${resp.status}`)
    console.error(JSON.stringify(payload, null, 2))
    if (resp.status === 401) {
      console.error('Auth required. Either disable Clerk for local dev, or sign in then re-run with APP_COOKIE=$(your_session_cookie)')
    }
    process.exit(3)
  }

  console.log('\nconnector summary:')
  console.log(JSON.stringify(payload?.connector, null, 2))
  console.log('\n✓ Pinata connector seeded. Open the operator terminal — header pill should flip to "pinata deployed" and the LOOP card "Autonomous mode" subsection should appear.')
}

main().catch((e) => {
  console.error('unexpected:', e)
  process.exit(99)
})
