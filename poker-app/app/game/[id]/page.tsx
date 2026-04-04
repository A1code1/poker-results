'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'

const CHIPS_PER_BUYING = 100
const EURO_PER_BUYING = 20
const HOST_FEE = 5

type Player = { id: string; name: string; buyingCount: number; washoutChips: number }
type Result = Player & { isHost: boolean; purchasedChips: number; investedEuro: number; normalizedWashoutChips: number; pokerCashoutEuro: number; hostFeeEuro: number; hostFeeReceivedEuro: number; netBalanceEuro: number }
type Transfer = { from: string; fromId: string; to: string; toId: string; amountEuro: number }
type Summary = { totalPlayers: number; totalBuyings: number; totalInvestedEuro: number; totalPurchasedChips: number; totalWashoutChips: number; normalizationApplied: boolean; totalHostFeePool: number; hostName: string }
type GameRecord = { id: string; players: Player[]; host_id: string; game_date: string | null; date_source: string | null; summary: Summary; results: Result[]; settlements: Transfer[]; created_at: string }

function fmt(n: number) { return Math.ceil(n) }

function formatGameDate(isoDate: string | null): string | null {
  if (!isoDate) return null
  try {
    const [y, m, d] = isoDate.split('-')
    return new Date(+y, +m - 1, +d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  } catch { return isoDate }
}

const T = {
  bg: '#f5f5f7',
  surface: '#ffffff',
  border: 'rgba(0,0,0,0.08)',
  text: '#1a1a2e',
  textMuted: '#6b7280',
  textDim: '#9ca3af',
  accent: '#6366f1',
  greenBg: '#ecfdf5',
  greenText: '#15803d',
  redBg: '#fef2f2',
  redText: '#b91c1c',
  radius: 14,
}

export default function SharedGamePage() {
  const params = useParams()
  const [game, setGame] = useState<GameRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const id = params.id as string
    if (!id) return
    Promise.resolve(supabase.from('games').select('*').eq('id', id).single())
      .then(({ data, error: err }) => {
        if (err || !data) { setError('Game not found'); setLoading(false); return }
        setGame(data as GameRecord)
        setLoading(false)
      })
      .catch(() => { setError('Failed to load game'); setLoading(false) })
  }, [params.id])

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: T.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Inter', -apple-system, sans-serif" }}>
        <p style={{ color: T.textMuted, fontSize: 16 }}>Loading game...</p>
      </div>
    )
  }

  if (error || !game) {
    return (
      <div style={{ minHeight: '100vh', background: T.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: "'Inter', -apple-system, sans-serif", padding: '2rem' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🃏</div>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: T.text, marginBottom: 8 }}>Game not found</h1>
        <p style={{ color: T.textMuted, fontSize: 14 }}>This game may have been deleted or the link is invalid.</p>
      </div>
    )
  }

  const { summary, results, settlements } = game
  const maxNet = Math.max(...results.map(r => r.netBalanceEuro))

  return (
    <div style={{ minHeight: '100vh', background: T.bg, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '1.5rem 1rem' }}>

        {/* Header */}
        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 24 }}>♠️</span>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: T.text }}>Poker Results</h1>
          </div>
          {game.game_date && (
            <p style={{ margin: 0, fontSize: 14, color: T.textMuted }}>📅 {formatGameDate(game.game_date)}</p>
          )}
        </div>

        {/* Metrics */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: 8, marginBottom: '1.25rem' }}>
          {[
            { label: 'Players', value: summary.totalPlayers },
            { label: 'Total buyings', value: summary.totalBuyings },
            { label: 'Pot size', value: `€${summary.totalInvestedEuro}` },
            { label: 'Host fee pool', value: `€${summary.totalHostFeePool}` },
            { label: 'Host', value: summary.hostName },
          ].map(m => (
            <div key={m.label} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: '0.75rem', textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{m.label}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: T.text }}>{m.value}</div>
            </div>
          ))}
        </div>

        {/* Player results table */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: '1rem 1.25rem', marginBottom: '1.25rem', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px', color: T.text }}>Player results</p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 500 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                {['Player', 'Host', 'Buyings', 'Invested', 'Chips', 'Cashout', 'Host fee', 'Net'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500, color: T.textDim, whiteSpace: 'nowrap', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.map((r: Result) => {
                const net = r.netBalanceEuro
                const isWinner = net === maxNet && net > 0
                return (
                  <tr key={r.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ padding: '8px 8px', color: T.text, whiteSpace: 'nowrap' }}>{r.name}{isWinner && ' 🥇'}</td>
                    <td style={{ padding: '8px 8px', textAlign: 'center' }}>{r.isHost ? '⭐' : ''}</td>
                    <td style={{ padding: '8px 8px', color: T.textMuted }}>{r.buyingCount}</td>
                    <td style={{ padding: '8px 8px', color: T.textMuted }}>€{fmt(r.investedEuro)}</td>
                    <td style={{ padding: '8px 8px', color: T.textMuted }}>{Math.round(r.normalizedWashoutChips)}</td>
                    <td style={{ padding: '8px 8px', color: T.textMuted }}>€{fmt(r.pokerCashoutEuro)}</td>
                    <td style={{ padding: '8px 8px' }}>{r.isHost ? <span style={{ color: T.greenText }}>+€{fmt(r.hostFeeReceivedEuro)}</span> : <span style={{ color: T.redText }}>-€{fmt(r.hostFeeEuro)}</span>}</td>
                    <td style={{ padding: '8px 8px' }}>
                      <span style={{ background: net > 0 ? T.greenBg : net < 0 ? T.redBg : 'transparent', color: net > 0 ? T.greenText : net < 0 ? T.redText : T.text, padding: '3px 10px', borderRadius: 20, fontWeight: 600, whiteSpace: 'nowrap', display: 'inline-block' }}>
                        {net >= 0 ? '+' : ''}€{fmt(net)}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Settlements */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: '1rem 1.25rem', marginBottom: '1.25rem' }}>
          <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px', color: T.text }}>Settlement — {settlements.length} transfer{settlements.length !== 1 ? 's' : ''}</p>
          {settlements.length === 0 ? (
            <p style={{ color: T.textMuted, fontSize: 14 }}>Everyone is settled — no transfers needed! 🎉</p>
          ) : settlements.map((s: Transfer, i: number) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', borderBottom: i < settlements.length - 1 ? `1px solid ${T.border}` : 'none', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 500, color: T.text }}>{s.to}</span>
              <span style={{ color: T.textDim, fontSize: 12 }}>receives from</span>
              <span style={{ fontWeight: 500, color: T.text }}>{s.from}</span>
              <span style={{ marginLeft: 'auto', background: T.greenBg, color: T.greenText, padding: '4px 12px', borderRadius: 20, fontWeight: 600, fontSize: 14 }}>€{fmt(s.amountEuro)}</span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{ textAlign: 'center', padding: '1rem 0', color: T.textDim, fontSize: 12 }}>
          ♠️ Poker Results
        </div>
      </div>
    </div>
  )
}
