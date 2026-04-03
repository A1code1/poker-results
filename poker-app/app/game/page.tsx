'use client'
import AuthGuard from '@/components/AuthGuard'
import PokerApp from '@/components/PokerApp'

export default function GamePage() {
  return (
    <AuthGuard>
      <PokerApp />
    </AuthGuard>
  )
}
