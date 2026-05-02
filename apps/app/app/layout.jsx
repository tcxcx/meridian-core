import { JetBrains_Mono, Space_Grotesk } from 'next/font/google'
import Script from 'next/script'
import { ClerkProvider } from '@clerk/nextjs'

import '@miroshark/ui/globals.css'
import './globals.css'

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
})

const sans = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-sans',
})

export const metadata = {
  title: 'MiroShark',
  description: 'Prediction market operator terminal.',
}

function allowedRedirectOrigins() {
  const origins = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.MIROSHARK_APP_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    'http://localhost:3301',
    'http://127.0.0.1:3301',
    'http://localhost:3302',
    'http://127.0.0.1:3302',
  ]
  if (process.env.NEXT_PUBLIC_CLERK_ALLOWED_REDIRECT_ORIGINS) {
    origins.push(...process.env.NEXT_PUBLIC_CLERK_ALLOWED_REDIRECT_ORIGINS.split(','))
  }
  return Array.from(new Set(origins.map((origin) => {
    try {
      return origin ? new URL(origin.trim()).origin : null
    } catch {
      return null
    }
  }).filter(Boolean)))
}

const clerkDevelopmentScriptPins = process.env.NODE_ENV === 'development'
  ? {
      __internal_clerkJSVersion: process.env.NEXT_PUBLIC_CLERK_JS_VERSION || '6.7.4',
      __internal_clerkUIVersion: process.env.NEXT_PUBLIC_CLERK_UI_VERSION || '1.6.2',
    }
  : {}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        {process.env.NODE_ENV === 'development' ? (
          <Script
            src="//unpkg.com/react-grab/dist/index.global.js"
            crossOrigin="anonymous"
            strategy="beforeInteractive"
          />
        ) : null}
      </head>
      <body className={`${mono.variable} ${sans.variable}`}>
        <ClerkProvider
          signInUrl="/sign-in"
          signUpUrl="/sign-up"
          signInFallbackRedirectUrl="/setup"
          signUpFallbackRedirectUrl="/setup"
          allowedRedirectOrigins={allowedRedirectOrigins()}
          {...clerkDevelopmentScriptPins}
        >
          {children}
        </ClerkProvider>
      </body>
    </html>
  )
}
