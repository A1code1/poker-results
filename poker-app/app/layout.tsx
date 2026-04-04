import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Amsterdam Poker',
  description: 'Track poker games, calculate payouts, settle up.',
  viewport: 'width=device-width, initial-scale=1, maximum-scale=1',
  robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
  icons: { icon: '/icon.png', apple: '/icon.png' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
