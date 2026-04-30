import { JetBrains_Mono, Space_Grotesk } from 'next/font/google'
import Script from 'next/script'

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
  title: 'Miroshark',
  description: 'Unified operator terminal for graph-native swarm trading and prediction market intelligence.',
}

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
        {children}
      </body>
    </html>
  )
}
