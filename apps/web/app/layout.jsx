import { JetBrains_Mono, Space_Grotesk } from 'next/font/google'

import '../../../packages/ui/src/globals.css'
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
  description: 'Prediction market hedge fund terminal.',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${mono.variable} ${sans.variable}`}>
        {children}
      </body>
    </html>
  )
}
