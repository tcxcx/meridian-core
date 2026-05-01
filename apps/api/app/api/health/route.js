import { NextResponse } from 'next/server'

export function GET() {
  return NextResponse.json({
    service: 'miroshark-platform-api',
    status: 'ok',
    backend: {
      signal: process.env.MIROSHARK_SIGNAL_URL || 'http://127.0.0.1:5002',
      execution: process.env.MIROSHARK_EXECUTION_URL || 'http://127.0.0.1:5004',
      backend: process.env.MIROSHARK_BACKEND_URL || 'http://127.0.0.1:5001',
    },
  })
}
