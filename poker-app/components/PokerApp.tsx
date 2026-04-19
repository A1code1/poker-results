'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { supabase } from '@/lib/supabase'

// ── Constants ─────────────────────────────────────────────────────────────────
const CHIPS_PER_BUYING = 100
const EURO_PER_BUYING = 20
const HOST_FEE = 5

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateId() { return Math.random().toString(36).slice(2, 9) }

function extractExifDate(base64: string): string | null {
  try {
    const bin = atob(base64.slice(0, 65536))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes[i] === 0xFF && bytes[i + 1] === 0xE1) {
        const chunk = bin.slice(i, i + 8192)
        const m = chunk.match(/(\d{4}):(\d{2}):(\d{2}) \d{2}:\d{2}:\d{2}/)
        if (m) return `${m[1]}-${m[2]}-${m[3]}`
      }
    }
  } catch { }
  return null
}

function formatGameDate(isoDate: string | null): string | null {
  if (!isoDate) return null
  try {
    const [y, m, d] = isoDate.split('-')
    return new Date(+y, +m - 1, +d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  } catch { return isoDate }
}

function fmt(n: number) { return Math.round(n) }

// Normalise any common date string to YYYY-MM-DD, returns null if unparseable
function normalizeDateStr(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim()
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // DD.MM.YYYY  or  D.M.YYYY
  const dotLong = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
  if (dotLong) return `${dotLong[3]}-${dotLong[2].padStart(2,'0')}-${dotLong[1].padStart(2,'0')}`
  // DD.MM.YY  or  D.M.YY  →  assume 20YY
  const dotShort = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/)
  if (dotShort) return `20${dotShort[3]}-${dotShort[2].padStart(2,'0')}-${dotShort[1].padStart(2,'0')}`
  // DD/MM/YYYY or D/M/YYYY
  const slashLong = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slashLong) return `${slashLong[3]}-${slashLong[2].padStart(2,'0')}-${slashLong[1].padStart(2,'0')}`
  // DD/MM/YY
  const slashShort = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/)
  if (slashShort) return `20${slashShort[3]}-${slashShort[2].padStart(2,'0')}-${slashShort[1].padStart(2,'0')}`
  return null
}

// Compress a data-URL image to a small JPEG data-URL (max 900px wide, quality 0.65)
async function compressImage(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const MAX = 900
      const scale = img.width > MAX ? MAX / img.width : 1
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.65))
    }
    img.onerror = () => resolve(dataUrl) // fallback: use original
    img.src = dataUrl
  })
}

function formatShortDate(isoDate: string | null): string {
  if (!isoDate) return ''
  try {
    const [y, m, d] = isoDate.split('-')
    return new Date(+y, +m - 1, +d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  } catch { return isoDate || '' }
}

// ── Types ─────────────────────────────────────────────────────────────────────
type RegisteredPlayer = { id: string; name: string; created_at: string; is_active: boolean }
type Player = { id: string; name: string; buyingCount: number; washoutChips: number; isHostDetected?: boolean; confidence?: Record<string, number>; registryId?: string | null; isOther?: boolean }
type Result = Player & { isHost: boolean; purchasedChips: number; investedEuro: number; normalizedWashoutChips: number; pokerCashoutEuro: number; hostFeeEuro: number; hostFeeReceivedEuro: number; netBalanceEuro: number }
type Transfer = { from: string; fromId: string; to: string; toId: string; amountEuro: number }
type Summary = { totalPlayers: number; totalBuyings: number; totalInvestedEuro: number; totalPurchasedChips: number; totalWashoutChips: number; normalizationApplied: boolean; totalHostFeePool: number; hostName: string }
type GameRecord = { id: string; players: Player[]; hostId: string; host_id?: string; gameDate: string | null; game_date?: string | null; dateSource: string | null; date_source?: string | null; summary: Summary; results: Result[]; settlements: Transfer[]; scoresheet_url?: string | null }

// ── Player matching ──────────────────────────────────────────────────────────
function matchPlayer(ocrName: string, registry: RegisteredPlayer[]): RegisteredPlayer | null {
  const n = ocrName.trim().toLowerCase()
  if (!n) return null
  // Pass 1: exact match
  const exact = registry.find(r => r.name.trim().toLowerCase() === n)
  if (exact) return exact
  // Pass 2: starts-with (either direction)
  const startsWith = registry.find(r => {
    const rn = r.name.trim().toLowerCase()
    return rn.startsWith(n) || n.startsWith(rn)
  })
  if (startsWith) return startsWith
  // Pass 3: first-name match (min 3 chars)
  const firstName = n.split(/\s+/)[0]
  if (firstName.length >= 3) {
    const firstMatch = registry.find(r => r.name.trim().toLowerCase().split(/\s+/)[0] === firstName)
    if (firstMatch) return firstMatch
  }
  // Pass 4: substring containment (min 3 chars)
  if (n.length >= 3) {
    const sub = registry.find(r => r.name.trim().toLowerCase().includes(n) || n.includes(r.name.trim().toLowerCase()))
    if (sub) return sub
  }
  return null
}

// ── Calculation ───────────────────────────────────────────────────────────────
function calculate(players: Player[], hostId: string) {
  const totalPlayers = players.length
  const totalPurchasedChips = players.reduce((s, p) => s + p.buyingCount * CHIPS_PER_BUYING, 0)
  const totalInvestedEuro = players.reduce((s, p) => s + p.buyingCount * EURO_PER_BUYING, 0)
  const totalRawWashout = players.reduce((s, p) => s + p.washoutChips, 0)
  const normalizationApplied = totalRawWashout !== totalPurchasedChips && totalRawWashout > 0
  const normFactor = normalizationApplied ? totalPurchasedChips / totalRawWashout : 1
  const totalHostFeePool = (totalPlayers - 1) * HOST_FEE

  const results: Result[] = players.map((p) => {
    const purchasedChips = p.buyingCount * CHIPS_PER_BUYING
    const investedEuro = p.buyingCount * EURO_PER_BUYING
    const normalizedWashoutChips = p.washoutChips * normFactor
    const pokerCashoutEuro = (normalizedWashoutChips / totalPurchasedChips) * totalInvestedEuro
    const isHost = p.id === hostId
    const hostFeeEuro = isHost ? 0 : HOST_FEE
    const hostFeeReceivedEuro = isHost ? totalHostFeePool : 0
    const netBalanceEuro = pokerCashoutEuro - investedEuro - hostFeeEuro + hostFeeReceivedEuro
    return { ...p, isHost, purchasedChips, investedEuro, normalizedWashoutChips: Math.round(normalizedWashoutChips * 100) / 100, pokerCashoutEuro, hostFeeEuro, hostFeeReceivedEuro, netBalanceEuro: Math.round(netBalanceEuro) }
  })

  const settlements = computeSettlements(results)
  const summary: Summary = { totalPlayers, totalBuyings: players.reduce((s, p) => s + p.buyingCount, 0), totalInvestedEuro, totalPurchasedChips, totalWashoutChips: totalRawWashout, normalizationApplied, totalHostFeePool, hostName: players.find((p) => p.id === hostId)?.name ?? '' }
  return { summary, results, settlements }
}

function computeSettlements(results: Result[]): Transfer[] {
  const cs = 100
  let debtors = results.filter(r => r.netBalanceEuro < -0.005).map(r => ({ id: r.id, name: r.name, balance: Math.round(r.netBalanceEuro * cs) })).sort((a, b) => a.balance - b.balance)
  let creditors = results.filter(r => r.netBalanceEuro > 0.005).map(r => ({ id: r.id, name: r.name, balance: Math.round(r.netBalanceEuro * cs) })).sort((a, b) => b.balance - a.balance)
  const transfers: Transfer[] = []
  while (debtors.length && creditors.length) {
    const debtor = debtors[0]; const creditor = creditors[0]
    const amount = Math.min(-debtor.balance, creditor.balance)
    if (amount > 0) transfers.push({ from: debtor.name, fromId: debtor.id, to: creditor.name, toId: creditor.id, amountEuro: Math.round(amount / cs) })
    debtor.balance += amount; creditor.balance -= amount
    if (Math.abs(debtor.balance) < 1) debtors.shift()
    if (Math.abs(creditor.balance) < 1) creditors.shift()
  }
  return transfers
}

// ── OCR ──────────────────────────────────────────────────────────────────────
async function runOCR(base64Image: string, mimeType: string) {
  const resp = await fetch('/api/ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64Image, mimeType }),
  })
  if (!resp.ok) throw new Error(`OCR API error: ${resp.status}`)
  return resp.json()
}

// ── Theme ────────────────────────────────────────────────────────────────────
const T = {
  bg: '#f5f5f7',
  surface: '#ffffff',
  surfaceHover: '#f0f0f5',
  border: 'rgba(0,0,0,0.08)',
  borderLight: 'rgba(0,0,0,0.12)',
  text: '#1a1a2e',
  textMuted: '#6b7280',
  textDim: '#9ca3af',
  accent: '#6366f1',
  accentGrad: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
  green: '#16a34a',
  greenBg: '#ecfdf5',
  greenText: '#15803d',
  red: '#dc2626',
  redBg: '#fef2f2',
  redText: '#b91c1c',
  yellow: '#ca8a04',
  yellowBg: '#fefce8',
  yellowText: '#a16207',
  radius: 14,
  radiusSm: 10,
}

// ── UI atoms ─────────────────────────────────────────────────────────────────
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: '1rem 1.25rem', ...style }}>{children}</div>
}

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: '1rem', textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: T.text }}>{value}</div>
    </div>
  )
}

function BackBtn({ onClick, label = 'Back' }: { onClick: () => void; label?: string }) {
  return <button onClick={onClick} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13, color: T.textMuted, transition: 'background 0.2s' }}>{label}</button>
}

function Btn({ children, onClick, variant = 'primary', style, disabled }: { children: React.ReactNode; onClick?: () => void; variant?: 'primary' | 'ghost' | 'danger'; style?: React.CSSProperties; disabled?: boolean }) {
  const base: React.CSSProperties = { width: '100%', border: 'none', borderRadius: 12, padding: '14px', fontSize: 16, fontWeight: 600, cursor: disabled ? 'wait' : 'pointer', transition: 'opacity 0.2s' }
  const variants: Record<string, React.CSSProperties> = {
    primary: { ...base, background: T.accentGrad, color: T.text },
    ghost: { ...base, background: T.surface, color: T.textMuted, border: `1px solid ${T.border}` },
    danger: { ...base, background: T.redBg, color: T.redText },
  }
  return <button onClick={onClick} disabled={disabled} style={{ ...variants[variant], ...style }}>{children}</button>
}

// ── Screen: Home ─────────────────────────────────────────────────────────────
function HomeScreen({ onNewGame, onHistory, onTournament, onAnalysis, onSettings, onSignOut }: { onNewGame: () => void; onHistory: () => void; onTournament: () => void; onAnalysis: () => void; onSettings: () => void; onSignOut: () => void }) {
  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '3rem 1.5rem 2rem' }}>
      <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
        <div style={{ fontSize: 52, marginBottom: 12 }}>♠️</div>
        <h1 style={{ fontSize: 32, fontWeight: 800, margin: '0 0 8px', letterSpacing: -1, color: T.text }}>Poker Results</h1>
        <p style={{ color: T.textMuted, fontSize: 15, margin: 0, lineHeight: 1.6 }}>Track games, calculate payouts,<br />and settle up in seconds.</p>
      </div>

      <Btn onClick={onNewGame} style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        <span style={{ fontSize: 20 }}>📷</span> New game results
      </Btn>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: '2.5rem' }}>
        {[{ icon: '📋', label: 'History', sub: 'All past games', fn: onHistory }, { icon: '🏆', label: 'Tournament', sub: 'Rankings', fn: onTournament }, { icon: '📊', label: 'My Stats', sub: 'Personal P&L', fn: onAnalysis }].map(item => (
          <button key={item.label} onClick={item.fn} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: '20px 12px', cursor: 'pointer', color: T.text, transition: 'border-color 0.2s' }}>
            <span style={{ fontSize: 28 }}>{item.icon}</span>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{item.label}</span>
            <span style={{ fontSize: 12, color: T.textMuted }}>{item.sub}</span>
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 20 }}>
        <button onClick={onSettings} style={{ background: 'none', border: 'none', color: T.textDim, fontSize: 13, cursor: 'pointer' }}>⚙️ Manage players</button>
        <button onClick={onSignOut} style={{ background: 'none', border: 'none', color: T.textDim, fontSize: 13, cursor: 'pointer' }}>Sign out</button>
      </div>
    </div>
  )
}

// ── Screen: Upload ───────────────────────────────────────────────────────────
function UploadScreen({ onParsed, onManual, onBack }: { onParsed: (d: any) => void; onManual: () => void; onBack: () => void }) {
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const processFile = useCallback(async (file: File) => {
    if (!file) return
    if (file.size > 15 * 1024 * 1024) { setError('File too large. Max 15 MB.'); return }
    setError(''); setLoading(true)
    try {
      const reader = new FileReader()
      const { base64, mime, previewUrl } = await new Promise<{ base64: string; mime: string; previewUrl: string }>((res, rej) => {
        reader.onload = (e) => {
          const dataUrl = e.target!.result as string
          const [header, b64] = dataUrl.split(',')
          const mime = header.match(/:(.*?);/)![1]
          res({ base64: b64, mime, previewUrl: dataUrl })
        }
        reader.onerror = rej
        reader.readAsDataURL(file)
      })

      const parsed = await runOCR(base64, mime)
      const players: Player[] = (parsed.players || []).map((p: any) => ({
        id: generateId(),
        name: (p.name || '').replace(/[*\u2605\u2726]+/g, '').trim(),
        buyingCount: Math.max(1, parseInt(p.buyingCount) || 1),
        washoutChips: Math.max(0, parseInt(p.washoutChips) || 0),
        isHostDetected: !!p.isHost,
        confidence: p.confidence || {},
      }))

      let gameDate: string | null = normalizeDateStr(parsed.date)
      let dateSource: string | null = null
      if (gameDate) { dateSource = 'sheet' }
      if (!gameDate) { const exif = extractExifDate(base64); if (exif) { gameDate = exif; dateSource = 'photo' } }
      if (!gameDate && file.lastModified) { gameDate = new Date(file.lastModified).toISOString().slice(0, 10); dateSource = 'file' }
      if (!gameDate) { gameDate = new Date().toISOString().slice(0, 10); dateSource = 'today' }

      // Compress image for storage (max 900px, JPEG 0.65)
      const compressedImage = await compressImage(previewUrl)

      const detectedHost = players.find(p => p.isHostDetected)
      onParsed({ players, warnings: parsed.warnings || [], previewUrl: compressedImage, gameDate, dateSource, detectedHostId: detectedHost?.id || null })
    } catch {
      setError('Could not read the image. Try manual entry instead.')
    } finally { setLoading(false) }
  }, [onParsed])

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <div style={{ marginBottom: '1rem' }}><BackBtn onClick={onBack} label="Home" /></div>
      <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>♠️</div>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0, color: T.text }}>New game</h1>
        <p style={{ color: T.textMuted, fontSize: 14, marginTop: 6 }}>Upload your score sheet photo</p>
      </div>

      <div onDragOver={e => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); processFile(e.dataTransfer.files[0]) }}
        onClick={() => inputRef.current?.click()}
        style={{ border: `2px dashed ${dragging ? T.accent : 'rgba(0,0,0,0.15)'}`, borderRadius: 16, padding: '3rem 2rem', textAlign: 'center', cursor: 'pointer', background: dragging ? 'rgba(99,102,241,0.06)' : T.surface, marginBottom: '1rem', transition: 'all 0.2s' }}>
        <input ref={inputRef} type="file" accept="image/*,.heic" style={{ display: 'none' }} onChange={e => e.target.files?.[0] && processFile(e.target.files[0])} />
        {loading ? (
          <div><div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div><p style={{ fontWeight: 500, margin: 0, color: T.text }}>Reading score sheet...</p><p style={{ color: T.textMuted, fontSize: 13, marginTop: 4 }}>This takes a few seconds</p></div>
        ) : (
          <div><div style={{ fontSize: 40, marginBottom: 12 }}>📷</div><p style={{ fontWeight: 500, margin: 0, color: T.text }}>Drop a photo here, or tap to upload</p><p style={{ color: T.textMuted, fontSize: 13, marginTop: 4 }}>JPG, PNG, WEBP — up to 15 MB</p></div>
        )}
      </div>

      {error && <div style={{ background: T.redBg, color: T.redText, borderRadius: 8, padding: '0.75rem 1rem', fontSize: 14, marginBottom: '1rem' }}>{error}</div>}
      <div style={{ textAlign: 'center' }}><button onClick={onManual} style={{ background: 'none', border: 'none', color: T.textMuted, fontSize: 14, cursor: 'pointer', textDecoration: 'underline' }}>Enter results manually instead</button></div>
    </div>
  )
}

// ── Screen: Review ───────────────────────────────────────────────────────────
function ReviewScreen({ players: init, warnings, previewUrl, gameDate: initDate, dateSource: initDateSource, detectedHostId, registry, onCalculate, onBack }: any) {
  const [gameDate, setGameDate] = useState<string | null>(initDate)
  const [dateSource, setDateSource] = useState<string | null>(initDateSource)
  const [editingDate, setEditingDate] = useState(false)
  const [players, setPlayers] = useState<Player[]>(() => {
    const initial: Player[] = init.length > 0 ? init : [{ id: generateId(), name: '', buyingCount: 1, washoutChips: 0, confidence: {} }]
    if (registry && registry.length > 0 && init.length > 0) {
      return initial.map((p: Player) => {
        if (p.registryId) return p
        const match = matchPlayer(p.name, registry)
        if (match) return { ...p, name: match.name, registryId: match.id, isOther: false }
        return p
      })
    }
    return initial
  })
  const [hostId, setHostId] = useState<string | null>(detectedHostId || null)
  const [error, setError] = useState('')

  const update = (id: string, field: string, value: any) => setPlayers(prev => prev.map(p => p.id === id ? { ...p, [field]: value } : p))
  const addRow = () => setPlayers(prev => [...prev, { id: generateId(), name: '', buyingCount: 1, washoutChips: 0, confidence: {} }])
  const removeRow = (id: string) => setPlayers(prev => prev.filter(p => p.id !== id))
  const lowConf = (p: Player, f: string) => (p.confidence?.[f] ?? 1) < 0.7

  const sourceLabels: Record<string, [string, string]> = {
    sheet: ['Read from sheet', T.accent],
    photo: ['From photo metadata', T.yellowText],
    file: ['From file date', T.textMuted],
    today: ["Today's date", T.textMuted],
    manual: ['Manually set', T.greenText],
  }

  const validate = () => {
    if (!players.length) return 'Add at least one player.'
    for (const p of players) {
      if (!p.name.trim()) return 'All players need a name.'
      if (p.buyingCount < 0) return 'Buying count must be 0 or more.'
    }
    if (!hostId) return 'Please select the host.'
    return null
  }

  const handleCalculate = () => {
    const err = validate(); if (err) { setError(err); return }
    setError(''); onCalculate(players, hostId, gameDate || new Date().toISOString().slice(0, 10), dateSource || 'today')
  }

  const totalBuyings = players.reduce((s, p) => s + (parseInt(String(p.buyingCount)) || 0), 0)
  const totalPurchased = totalBuyings * CHIPS_PER_BUYING
  const totalCashout = players.reduce((s, p) => s + (parseInt(String(p.washoutChips)) || 0), 0)
  const balanced = totalCashout === totalPurchased

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
        <BackBtn onClick={onBack} />
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Review players</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            {editingDate ? (
              <input type="date" value={gameDate || ''} autoFocus onChange={e => { setGameDate(e.target.value); setDateSource('manual') }} onBlur={() => setEditingDate(false)}
                style={{ fontSize: 13, border: `1px solid ${T.accent}`, borderRadius: 6, padding: '3px 8px', color: T.text, background: '#f0f0f5' }} />
            ) : (
              <button onClick={() => setEditingDate(true)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13, color: T.textMuted }}>📅 {gameDate ? formatGameDate(gameDate) : 'Set date'}</span>
                <span style={{ fontSize: 11, color: T.textDim }}>✏️</span>
              </button>
            )}
            {dateSource && !editingDate && sourceLabels[dateSource] && (
              <span style={{ fontSize: 11, color: sourceLabels[dateSource][1], background: '#f0f0f5', padding: '2px 8px', borderRadius: 20, fontWeight: 500 }}>{sourceLabels[dateSource][0]}</span>
            )}
          </div>
        </div>
      </div>

      {previewUrl && (
        <Card style={{ marginBottom: '1rem' }}>
          <p style={{ fontSize: 12, color: T.textMuted, margin: '0 0 8px' }}>Uploaded image</p>
          <img src={previewUrl} alt="score sheet" style={{ width: '100%', borderRadius: 8, maxHeight: 220, objectFit: 'contain' }} />
        </Card>
      )}

      {warnings.length > 0 && (
        <div style={{ background: T.yellowBg, border: `1px solid rgba(234,179,8,0.3)`, borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1rem' }}>
          {warnings.map((w: string, i: number) => <p key={i} style={{ fontSize: 12, color: T.yellowText, margin: '2px 0' }}>⚠️ {w}</p>)}
        </div>
      )}

      <Card style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 90px 32px 60px', gap: 8, marginBottom: 8 }}>
          {['Player name', 'Buyings', 'Cashout', '', 'Host'].map(h => <span key={h} style={{ fontSize: 11, color: T.textDim, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</span>)}
        </div>
        {players.map(p => {
          const isMatched = !!p.registryId
          const isGuest = !!p.isOther
          const hasRegistry = registry && registry.length > 0
          const isUnmatched = !isMatched && !isGuest && hasRegistry && p.name.trim().length > 0
          const borderColor = isMatched ? T.green : isGuest ? T.yellow : isUnmatched ? T.red : T.border
          const handleNameChange = (newName: string) => {
            const match = hasRegistry ? matchPlayer(newName, registry) : null
            if (match) {
              setPlayers(prev => prev.map(x => x.id === p.id ? { ...x, name: match.name, registryId: match.id, isOther: false } : x))
            } else {
              setPlayers(prev => prev.map(x => x.id === p.id ? { ...x, name: newName, registryId: null, isOther: false } : x))
            }
          }
          const handleDropdown = (val: string) => {
            if (val === '__other__') { setPlayers(prev => prev.map(x => x.id === p.id ? { ...x, isOther: true, registryId: null } : x)) }
            else if (val === '__unlinked__') { setPlayers(prev => prev.map(x => x.id === p.id ? { ...x, isOther: false, registryId: null } : x)) }
            else {
              const reg = registry.find((r: RegisteredPlayer) => r.id === val)
              if (reg) setPlayers(prev => prev.map(x => x.id === p.id ? { ...x, name: reg.name, registryId: reg.id, isOther: false } : x))
            }
          }
          return (
          <div key={p.id} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 90px 32px 60px', gap: 8, marginBottom: 10, alignItems: 'start' }}>
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', border: `1.5px solid ${borderColor}`, borderRadius: 8, overflow: 'hidden' }}>
                <input value={p.name} onChange={e => handleNameChange(e.target.value)} placeholder="Name"
                  style={{ background: 'transparent', borderRadius: 0, padding: '8px 10px', fontSize: 14, border: 'none', flex: 1, color: T.text, outline: 'none' }} />
                {hasRegistry && (
                  <select value={p.isOther ? '__other__' : p.registryId || '__unlinked__'} onChange={e => handleDropdown(e.target.value)}
                    style={{ fontSize: 12, background: 'transparent', border: 'none', borderLeft: `1px solid ${T.border}`, padding: '4px 6px', color: isMatched ? T.greenText : isGuest ? T.yellowText : isUnmatched ? T.redText : T.textMuted, outline: 'none', cursor: 'pointer', minWidth: 28 }} title="Select player">
                    <option value="__unlinked__">{p.name.trim() ? '?' : 'Pick...'}</option>
                    <option value="__other__">Guest</option>
                    {registry.map((r: RegisteredPlayer) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                )}
              </div>
              {isMatched && <span style={{ fontSize: 10, color: T.greenText, fontWeight: 600, marginTop: 2, display: 'block' }}>✓ Matched</span>}
              {isGuest && <span style={{ fontSize: 10, color: T.yellowText, fontWeight: 600, marginTop: 2, display: 'block' }}>🎲 Guest</span>}
              {isUnmatched && <span style={{ fontSize: 10, color: T.redText, fontWeight: 600, marginTop: 2, display: 'block' }}>Not matched</span>}
            </div>
            <input type="number" min="1" value={p.buyingCount} onChange={e => update(p.id, 'buyingCount', parseInt(e.target.value) || 1)}
              style={{ background: lowConf(p, 'buyingCount') ? T.yellowBg : '#f0f0f5', borderRadius: 8, padding: '8px 10px', fontSize: 14, border: `1px solid ${T.border}`, width: '100%', color: T.text, outline: 'none' }} />
            <input type="number" min="0" value={p.washoutChips} onChange={e => update(p.id, 'washoutChips', parseInt(e.target.value) || 0)}
              style={{ background: '#f0f0f5', borderRadius: 8, padding: '8px 10px', fontSize: 14, border: `1px solid ${T.border}`, width: '100%', color: T.text, outline: 'none' }} />
            <button onClick={() => removeRow(p.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textDim, fontSize: 16, padding: 0, marginTop: 8 }}>✕</button>
            <div style={{ textAlign: 'center', marginTop: 8 }}>
              <input type="radio" name="host" checked={hostId === p.id} onChange={() => setHostId(p.id)} style={{ accentColor: T.accent, cursor: 'pointer', width: 16, height: 16 }} />
            </div>
          </div>
        )})}
        <button onClick={addRow} style={{ marginTop: 8, background: 'none', border: `1px dashed rgba(0,0,0,0.15)`, borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontSize: 13, color: T.textMuted, width: '100%' }}>+ Add player</button>
      </Card>

      {players.length > 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: '0.75rem' }}>
            <MetricCard label="Players" value={players.length} />
            <MetricCard label="Purchased chips" value={totalPurchased} />
            <MetricCard label="Cashout chips" value={totalCashout} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: balanced ? T.greenBg : T.yellowBg, border: `1px solid ${balanced ? 'rgba(34,197,94,0.3)' : 'rgba(234,179,8,0.3)'}`, borderRadius: 8, padding: '10px 14px', marginBottom: '1rem', fontSize: 13 }}>
            <span>{balanced ? '✅' : '⚠️'}</span>
            {balanced
              ? <span style={{ color: T.greenText, fontWeight: 500 }}>Chips add up — no normalization needed.</span>
              : <span style={{ color: T.yellowText }}><strong>Chips don&apos;t add up</strong> — cashout is {totalCashout - totalPurchased > 0 ? '+' : ''}{totalCashout - totalPurchased} vs purchased. Payouts will be normalized automatically.</span>}
          </div>
        </>
      )}

      {error && <div style={{ background: T.redBg, color: T.redText, borderRadius: 8, padding: '0.75rem 1rem', fontSize: 14, marginBottom: '1rem' }}>{error}</div>}
      <Btn onClick={handleCalculate}>Calculate payouts</Btn>
    </div>
  )
}

// ── Screen: Results ──────────────────────────────────────────────────────────
function ResultsScreen({ players, hostId, gameDate: initDate, dateSource: initSource, gameId, onBack, onSave, onHome, onDateChange, onEdit, onCancel, readOnly, saveLabel, previewUrl, scoresheetUrl }: any) {
  const { summary, results, settlements } = calculate(players, hostId)
  const [imgStatus, setImgStatus] = useState('idle')
  const [linkCopied, setLinkCopied] = useState(false)
  const [gameDate, setGameDate] = useState<string>(initDate || new Date().toISOString().slice(0, 10))
  const [dateSource, setDateSource] = useState<string>(initSource || 'today')
  const [editingDate, setEditingDate] = useState(false)
  const [dateChanged, setDateChanged] = useState(false)
  const [dateSaved, setDateSaved] = useState(false)
  const [showEditConfirm, setShowEditConfirm] = useState(false)
  const [showPhoto, setShowPhoto] = useState(false)
  const photoUrl = scoresheetUrl || previewUrl
  const cardRef = useRef<HTMLDivElement>(null)
  const h2cRef = useRef<Promise<any> | null>(null)

  useEffect(() => {
    if ((window as any).html2canvas) { h2cRef.current = Promise.resolve((window as any).html2canvas); return }
    if (!document.getElementById('h2c-script')) {
      h2cRef.current = new Promise((res, rej) => {
        const s = document.createElement('script'); s.id = 'h2c-script'
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
        s.onload = () => res((window as any).html2canvas); s.onerror = rej
        document.head.appendChild(s)
      })
    } else {
      h2cRef.current = new Promise((res, rej) => {
        const t = setInterval(() => { if ((window as any).html2canvas) { clearInterval(t); res((window as any).html2canvas) } }, 50)
        setTimeout(() => { clearInterval(t); rej(new Error('Timeout')) }, 10000)
      })
    }
  }, [])

  const handleDateChange = (val: string) => { setGameDate(val); setDateSource('manual'); setDateChanged(true); setDateSaved(false); onDateChange?.(val, 'manual') }

  const handleShare = async () => {
    setImgStatus('loading')
    try {
      const h2c = await (h2cRef.current || Promise.reject(new Error('Not loaded')))
      const canvas = await h2c(cardRef.current, { backgroundColor: '#ffffff', scale: 2, useCORS: true, logging: false })
      const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b: Blob | null) => b ? res(b) : rej(new Error('toBlob null')), 'image/png'))
      if (navigator.clipboard && (window as any).ClipboardItem) {
        try { await navigator.clipboard.write([new (window as any).ClipboardItem({ 'image/png': blob })]); setImgStatus('copied'); setTimeout(() => setImgStatus('idle'), 3000); return } catch { }
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = 'poker-results.png'
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setImgStatus('downloaded'); setTimeout(() => setImgStatus('idle'), 3000)
    } catch (e) { console.error(e); setImgStatus('error'); setTimeout(() => setImgStatus('idle'), 3000) }
  }

  const sourceLabels: Record<string, [string, string]> = {
    sheet: ['Read from sheet', T.accent],
    photo: ['From photo metadata', T.yellowText],
    file: ['From file date', T.textMuted],
    today: ["Today's date", T.textMuted],
    manual: ['Manually set', T.greenText],
  }

  const POKER_TIPS = [
    "Position is power. The later you act, the more information you have.",
    "Don't chase draws without the right pot odds.",
    "Fold more from early position. Play tighter when first to act.",
    "Pay attention to bet sizing — it often reveals hand strength.",
    "3-bet your premium hands. Limping with aces and kings is a trap for you, not them.",
    "Bankroll management is what separates pros from tourists.",
    "Take notes on your opponents' tendencies — patterns repeat.",
    "A continuation bet doesn't always mean strength.",
  ]
  const tipIndex = Math.abs((gameDate || '').split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)) % POKER_TIPS.length
  const tip = POKER_TIPS[tipIndex]

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <div ref={cardRef} style={{ background: T.surface, padding: '1.25rem', borderRadius: T.radius }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
          <BackBtn onClick={onBack} label="Edit" />
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Final results</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
              {editingDate ? (
                <input type="date" value={gameDate || ''} autoFocus onChange={e => handleDateChange(e.target.value)} onBlur={() => setEditingDate(false)}
                  style={{ fontSize: 13, border: `1px solid ${T.border}`, borderRadius: 6, padding: '3px 8px', background: T.surface, color: T.text }} />
              ) : (
                <button onClick={() => setEditingDate(true)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <p style={{ margin: 0, fontSize: 13, color: T.textMuted }}>📅 {gameDate ? formatGameDate(gameDate) : 'Set date'}</p>
                  <span style={{ fontSize: 11, color: T.textDim }}>✏️</span>
                </button>
              )}
              {dateSource && !editingDate && sourceLabels[dateSource] && (
                <span style={{ fontSize: 11, color: sourceLabels[dateSource][1], background: '#f0f0f5', padding: '2px 8px', borderRadius: 20, fontWeight: 500 }}>{sourceLabels[dateSource][0]}</span>
              )}
              {gameId && !editingDate && (
                <button onClick={async () => {
                  const { error } = await supabase.from('games').update({ game_date: gameDate, date_source: 'manual' }).eq('id', gameId)
                  if (!error) { setDateChanged(false); setDateSaved(true); setDateSource('manual'); setTimeout(() => setDateSaved(false), 3000) }
                  else { alert('Failed to save date') }
                }} style={{ fontSize: 11, background: dateSaved ? T.greenBg : dateChanged ? T.accent : '#f0f0f5', color: dateSaved ? T.greenText : dateChanged ? '#fff' : T.textMuted, border: `1px solid ${dateSaved ? T.green : dateChanged ? T.accent : T.border}`, borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontWeight: 600 }}>
                  {dateSaved ? '✓ Saved' : dateChanged ? 'Save date' : 'Update date'}
                </button>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: photoUrl ? '0.75rem' : '1.25rem' }}>
          <MetricCard label="Players" value={summary.totalPlayers} />
          <MetricCard label="Total buyings" value={summary.totalBuyings} />
          <MetricCard label="Pot size" value={`\u20ac${summary.totalInvestedEuro}`} />
          <MetricCard label="Host fee pool" value={`\u20ac${summary.totalHostFeePool}`} />
          <MetricCard label="Host" value={summary.hostName} />
        </div>

        {photoUrl && (
          <button onClick={() => setShowPhoto(true)} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#eef2ff', border: `1px solid #c7d2fe`, borderRadius: 10, padding: '10px 16px', marginBottom: '1.25rem', cursor: 'pointer', width: '100%', fontSize: 14, color: T.accent, fontWeight: 600 }}>
            <span style={{ fontSize: 20 }}>📷</span>
            <span>View score sheet</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: T.textMuted, fontWeight: 400 }}>tap to open</span>
          </button>
        )}

        {summary.normalizationApplied && (
          <div style={{ background: T.yellowBg, border: `1px solid rgba(234,179,8,0.3)`, borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: 13, color: T.yellowText }}>
            ⚠️ Cashout chips ({summary.totalWashoutChips}) didn&apos;t match purchased chips ({summary.totalPurchasedChips}). Results normalized automatically.
          </div>
        )}

        <Card style={{ marginBottom: '1.25rem', overflowX: 'auto' }}>
          <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px', color: T.text }}>Player results</p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                {['Player', 'Host', 'Buyings', 'Invested', 'Chips', 'Poker cashout', 'Host fee', 'Net balance'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500, color: T.textDim, whiteSpace: 'nowrap', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(() => {
                const maxNet = Math.max(...results.map((r: Result) => r.netBalanceEuro))
                return results.map((r: Result) => {
                  const net = r.netBalanceEuro
                  const isWinner = net === maxNet && net > 0
                  const netColor = net > 0 ? T.greenText : net < 0 ? T.redText : T.text
                  const netBg = net > 0 ? T.greenBg : net < 0 ? T.redBg : 'transparent'
                  return (
                    <tr key={r.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                      <td style={{ padding: '8px 8px', color: T.text }}>{r.name}{isWinner && <span style={{ fontSize: 16, marginLeft: 6 }}>🥇</span>}</td>
                      <td style={{ padding: '8px 8px', textAlign: 'center' }}>{r.isHost ? '⭐' : ''}</td>
                      <td style={{ padding: '8px 8px', color: T.textMuted }}>{r.buyingCount}</td>
                      <td style={{ padding: '8px 8px', color: T.textMuted }}>&euro;{fmt(r.investedEuro)}</td>
                      <td style={{ padding: '8px 8px', color: T.textMuted }}>{Math.round(r.normalizedWashoutChips)}</td>
                      <td style={{ padding: '8px 8px', color: T.textMuted }}>&euro;{fmt(r.pokerCashoutEuro)}</td>
                      <td style={{ padding: '8px 8px' }}>{r.isHost ? <span style={{ color: T.greenText }}>+&euro;{fmt(r.hostFeeReceivedEuro)}</span> : <span style={{ color: T.redText }}>-&euro;{fmt(r.hostFeeEuro)}</span>}</td>
                      <td style={{ padding: '8px 8px' }}>
                        <span style={{ background: netBg, color: netColor, padding: '3px 10px', borderRadius: 20, fontWeight: 600, whiteSpace: 'nowrap', display: 'inline-block', lineHeight: '1.4', verticalAlign: 'middle' }}>
                          {net >= 0 ? '+' : ''}&euro;{fmt(net)}
                        </span>
                      </td>
                    </tr>
                  )
                })
              })()}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `2px solid ${T.border}`, background: '#f8f8fb' }}>
                <td style={{ padding: '8px 8px', fontWeight: 600, color: T.text }}>Totals</td>
                <td></td>
                <td style={{ padding: '8px 8px', fontWeight: 600, color: T.text }}>{results.reduce((s: number, r: Result) => s + r.buyingCount, 0)}</td>
                <td style={{ padding: '8px 8px', fontWeight: 600, color: T.text }}>&euro;{fmt(results.reduce((s: number, r: Result) => s + r.investedEuro, 0))}</td>
                <td style={{ padding: '8px 8px', fontWeight: 600, color: T.text }}>{results.reduce((s: number, r: Result) => s + Math.round(r.normalizedWashoutChips), 0)}</td>
                <td style={{ padding: '8px 8px', fontWeight: 600, color: T.text }}>&euro;{fmt(results.reduce((s: number, r: Result) => s + r.pokerCashoutEuro, 0))}</td>
                <td style={{ padding: '8px 8px', fontWeight: 600, color: T.text }}>&euro;{fmt(results.reduce((s: number, r: Result) => s + r.hostFeeReceivedEuro - r.hostFeeEuro, 0))}</td>
                <td style={{ padding: '8px 8px', fontWeight: 600, color: T.text }}>&euro;{fmt(results.reduce((s: number, r: Result) => s + r.netBalanceEuro, 0))}</td>
              </tr>
            </tfoot>
          </table>
        </Card>

        <Card style={{ marginBottom: '1.25rem' }}>
          <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px', color: T.text }}>Settlement — {settlements.length} transfer{settlements.length !== 1 ? 's' : ''}</p>
          {settlements.length === 0 ? (
            <p style={{ color: T.textMuted, fontSize: 14 }}>Everyone is settled — no transfers needed! 🎉</p>
          ) : settlements.map((s: Transfer, i: number) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: i < settlements.length - 1 ? `1px solid ${T.border}` : 'none' }}>
              <span style={{ fontWeight: 500, color: T.text }}>{s.to}</span>
              <span style={{ color: T.textDim }}>receives from</span>
              <span style={{ fontWeight: 500, color: T.text }}>{s.from}</span>
              <span style={{ marginLeft: 'auto', background: T.greenBg, color: T.greenText, padding: '4px 12px', borderRadius: 20, fontWeight: 600, fontSize: 14, display: 'inline-block', lineHeight: '1.4', verticalAlign: 'middle' }}>&euro;{fmt(s.amountEuro)}</span>
            </div>
          ))}
        </Card>

      <Btn onClick={handleShare} disabled={imgStatus === 'loading'} variant={imgStatus === 'copied' || imgStatus === 'downloaded' ? 'ghost' : 'primary'} style={{ marginBottom: 8 }}>
        {imgStatus === 'loading' && '⏳ Generating image...'}
        {imgStatus === 'copied' && '✓ Image copied — paste in WhatsApp!'}
        {imgStatus === 'downloaded' && '✓ Image saved — share from your photos!'}
        {imgStatus === 'error' && '⚠️ Could not generate image'}
        {imgStatus === 'idle' && '📸 Save as image to share'}
      </Btn>

      {gameId && (
        <Btn onClick={() => {
          const url = `${window.location.origin}/game/${gameId}`
          navigator.clipboard.writeText(url).then(() => { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 3000) }).catch(() => { window.prompt('Copy this link:', url) })
        }} variant="ghost" style={{ marginBottom: '1rem' }}>
          {linkCopied ? '✓ Link copied!' : '🔗 Copy shareable link'}
        </Btn>
      )}

      <div style={{ margin: '1.25rem 0 0', borderTop: `1px solid ${T.border}`, paddingTop: '1rem', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 22, flexShrink: 0 }}>🃏</span>
        <div>
          <p style={{ margin: '0 0 3px', fontSize: 11, fontWeight: 600, color: T.textDim, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Pro tip</p>
          <p style={{ margin: 0, fontSize: 13, color: T.textMuted, lineHeight: 1.6, fontStyle: 'italic' }}>{tip}</p>
        </div>
      </div>

      </div>{/* end cardRef */}

      {/* Photo overlay */}
      {showPhoto && photoUrl && (
        <div onClick={() => setShowPhoto(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '1rem' }}>
          <div onClick={e => e.stopPropagation()} style={{ position: 'relative', maxWidth: 640, width: '100%' }}>
            <button onClick={() => setShowPhoto(false)} style={{ position: 'absolute', top: -14, right: -14, background: '#fff', border: 'none', borderRadius: '50%', width: 32, height: 32, fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1, boxShadow: '0 2px 8px rgba(0,0,0,0.3)', lineHeight: 1 }}>×</button>
            <img src={photoUrl} alt="score sheet" style={{ width: '100%', borderRadius: 12, maxHeight: '80vh', objectFit: 'contain', display: 'block' }} />
          </div>
        </div>
      )}

      {!readOnly && onSave && (
        <Btn onClick={async () => { await onSave({ players, hostId, gameDate, dateSource, summary, results, settlements, previewUrl }); onHome?.() }} variant="ghost" style={{ marginTop: 10 }}>
          {saveLabel || '💾 Save game & go home'}
        </Btn>
      )}
      {!readOnly && onCancel && (
        <Btn onClick={onCancel} variant="ghost" style={{ marginTop: 8, opacity: 0.7 }}>Cancel</Btn>
      )}
      {(readOnly || !onSave) && onHome && (
        <Btn onClick={onHome} variant="ghost" style={{ marginTop: 10 }}>Home</Btn>
      )}
      {readOnly && gameId && onEdit && (
        <>
          <div style={{ marginTop: 40, textAlign: 'center' }}>
            <button onClick={() => setShowEditConfirm(true)} style={{ background: 'none', border: 'none', color: T.textDim, fontSize: 12, cursor: 'pointer', opacity: 0.5 }}>Edit results</button>
          </div>
          {showEditConfirm && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '1rem' }}>
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: '2rem', maxWidth: 380, width: '100%', textAlign: 'center' }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
                <h3 style={{ margin: '0 0 8px', color: T.text, fontSize: 18, fontWeight: 700 }}>Edit official records?</h3>
                <p style={{ color: T.textMuted, fontSize: 14, marginBottom: 20 }}>You are about to modify the official game records. Changes will affect settlements and tournament standings. Are you sure?</p>
                <div style={{ display: 'flex', gap: 10 }}>
                  <Btn onClick={() => setShowEditConfirm(false)} variant="ghost" style={{ flex: 1 }}>Cancel</Btn>
                  <Btn onClick={() => { setShowEditConfirm(false); onEdit() }} variant="primary" style={{ flex: 1 }}>Edit game</Btn>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Screen: History ──────────────────────────────────────────────────────────
function HistoryScreen({ games, loading, onBack, onViewGame, onDelete, undoGame, onUndo }: { games: GameRecord[]; loading: boolean; onBack: () => void; onViewGame: (g: GameRecord) => void; onDelete: (id: string) => void; undoGame: GameRecord | null; onUndo: () => void }) {
  const [deleteId, setDeleteId] = useState<string | null>(null)

  return (
    <div style={{ maxWidth: 540, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
        <BackBtn onClick={onBack} label="Home" />
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Game history</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: T.textDim }}>{games.length} game{games.length !== 1 ? 's' : ''}</span>
      </div>
      {loading && <p style={{ color: T.textMuted, textAlign: 'center', padding: '2rem' }}>Loading...</p>}
      {!loading && games.length === 0 && !undoGame && (
        <div style={{ textAlign: 'center', padding: '4rem 1rem' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🃏</div>
          <p style={{ fontWeight: 500, margin: '0 0 6px', color: T.text }}>No games yet</p>
          <p style={{ color: T.textMuted, fontSize: 14 }}>Completed games will appear here.</p>
        </div>
      )}

      {/* Undo toast */}
      {undoGame && (
        <div style={{ background: '#1a1a2e', color: '#fff', borderRadius: 12, padding: '12px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, animation: 'fadeIn 0.2s' }}>
          <span style={{ flex: 1, fontSize: 14 }}>Game deleted — {formatGameDate((undoGame as any).game_date || (undoGame as any).gameDate) || 'game'}</span>
          <button onClick={onUndo} style={{ background: T.accent, color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Undo</button>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteId && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '1rem' }}>
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: '2rem', maxWidth: 380, width: '100%', textAlign: 'center' }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
            <h3 style={{ margin: '0 0 8px', color: T.text, fontSize: 18, fontWeight: 700 }}>Delete game?</h3>
            <p style={{ color: T.textMuted, fontSize: 14, marginBottom: 20 }}>You are about to delete this game. Are you sure?</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <Btn onClick={() => setDeleteId(null)} variant="ghost" style={{ flex: 1 }}>Cancel</Btn>
              <Btn onClick={() => { onDelete(deleteId); setDeleteId(null) }} variant="danger" style={{ flex: 1 }}>Delete</Btn>
            </div>
          </div>
        </div>
      )}

      {[...games].sort((a, b) => ((b.game_date || b.gameDate) || '').localeCompare((a.game_date || a.gameDate) || '')).map((g, i) => {
        const winner = [...(g.results as Result[])].sort((a, b) => b.netBalanceEuro - a.netBalanceEuro)[0]
        return (
          <div key={g.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: '1rem 1.25rem', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => onViewGame(g)}>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4, color: T.text }}>{g.gameDate || g.game_date ? formatGameDate(g.gameDate || g.game_date || null) : `Game ${games.length - i}`}</div>
              <div style={{ fontSize: 12, color: T.textMuted }}>
                {(g.summary as Summary).totalPlayers} players &middot; {(g.summary as Summary).totalBuyings} buy-ins &middot; &euro;{(g.summary as Summary).totalInvestedEuro} pot{winner && <span> &middot; 🥇 {winner.name}</span>}
              </div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); const url = `${window.location.origin}/game/${g.id}`; navigator.clipboard.writeText(url).catch(() => {}); const btn = e.currentTarget; btn.textContent = '✓'; setTimeout(() => { btn.textContent = '🔗' }, 2000) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textDim, fontSize: 16, padding: '4px 8px', borderRadius: 6 }} title="Copy link">
              🔗
            </button>
            <button onClick={(e) => { e.stopPropagation(); setDeleteId(g.id) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textDim, fontSize: 16, padding: '4px 8px', borderRadius: 6 }} title="Delete game">
              🗑️
            </button>
            <span style={{ color: T.textDim, fontSize: 18, cursor: 'pointer' }} onClick={() => onViewGame(g)}>›</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Screen: Settings ─────────────────────────────────────────────────────────
function SettingsScreen({ registry, onBack, onAdd, onUpdate, onDelete }: { registry: RegisteredPlayer[]; onBack: () => void; onAdd: (name: string) => Promise<void>; onUpdate: (id: string, name: string) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const [newName, setNewName] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const handleAdd = async () => {
    const name = newName.trim()
    if (!name) return
    await onAdd(name)
    setNewName('')
  }

  const handleSaveEdit = async () => {
    if (!editId || !editName.trim()) return
    await onUpdate(editId, editName.trim())
    setEditId(null)
    setEditName('')
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
        <BackBtn onClick={onBack} label="Home" />
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Manage players</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: T.textDim }}>{registry.length} player{registry.length !== 1 ? 's' : ''}</span>
      </div>

      <p style={{ color: T.textMuted, fontSize: 13, marginBottom: '1rem' }}>Add your regular players so names are auto-matched from score sheets. One-time guests can be marked as "Guest" during game entry.</p>

      <Card style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()} placeholder="Player name" style={{ flex: 1, background: '#f0f0f5', border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 14, color: T.text, outline: 'none' }} />
          <button onClick={handleAdd} style={{ background: T.accentGrad, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>+ Add</button>
        </div>
      </Card>

      {registry.length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>👥</div>
          <p style={{ color: T.textMuted, fontSize: 14 }}>No players yet. Add your regular poker group above.</p>
        </div>
      )}

      {registry.map(p => (
        <div key={p.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: '10px 14px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
          {editId === p.id ? (
            <>
              <input value={editName} onChange={e => setEditName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSaveEdit()} autoFocus style={{ flex: 1, background: '#f0f0f5', border: `1px solid ${T.accent}`, borderRadius: 6, padding: '6px 10px', fontSize: 14, color: T.text, outline: 'none' }} />
              <button onClick={handleSaveEdit} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.greenText, fontSize: 14, fontWeight: 600 }}>Save</button>
              <button onClick={() => setEditId(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textDim, fontSize: 14 }}>Cancel</button>
            </>
          ) : (
            <>
              <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: T.text }}>{p.name}</span>
              <button onClick={() => { setEditId(p.id); setEditName(p.name) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textDim, fontSize: 14 }}>✏️</button>
              <button onClick={() => onDelete(p.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textDim, fontSize: 14 }}>🗑️</button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Screen: Tournament ───────────────────────────────────────────────────────
function TournamentScreen({ games, loading, onBack }: { games: GameRecord[]; loading: boolean; onBack: () => void }) {
  const playerMap: Record<string, { name: string; games: number; totalNet: number; wins: number }> = {}
  games.forEach(g => {
    const eligible = (g.results as Result[]).filter(r => !r.isOther)
    eligible.forEach(r => {
      const key = r.registryId || `name:${r.name.trim().toLowerCase()}`
      if (!playerMap[key]) playerMap[key] = { name: r.name, games: 0, totalNet: 0, wins: 0 }
      playerMap[key].games += 1
      const pokerOnlyNet = Math.round(r.pokerCashoutEuro - r.investedEuro)
      playerMap[key].totalNet += pokerOnlyNet
    })
    const winner = [...eligible].sort((a, b) => {
      const aPoker = Math.round(a.pokerCashoutEuro - a.investedEuro)
      const bPoker = Math.round(b.pokerCashoutEuro - b.investedEuro)
      return bPoker - aPoker
    })[0]
    if (winner) { const key = winner.registryId || `name:${winner.name.trim().toLowerCase()}`; if (playerMap[key]) playerMap[key].wins += 1 }
  })
  const rankings = Object.values(playerMap).sort((a, b) => b.totalNet - a.totalNet)
  const medals = ['🥇', '🥈', '🥉']

  // Longest winning streak
  const sortedGames = [...games].sort((a, b) => ((a.game_date || a.gameDate) || '').localeCompare((b.game_date || b.gameDate) || ''))
  let bestStreak = { name: '', streak: 0 }
  let currentStreak = { name: '', streak: 0 }
  sortedGames.forEach(g => {
    const eligible = (g.results as Result[]).filter(r => !r.isOther)
    const winner = [...eligible].sort((a, b) => {
      return Math.round(b.pokerCashoutEuro - b.investedEuro) - Math.round(a.pokerCashoutEuro - a.investedEuro)
    })[0]
    if (winner) {
      const wName = winner.name.trim()
      if (wName === currentStreak.name) { currentStreak.streak += 1 }
      else { currentStreak = { name: wName, streak: 1 } }
      if (currentStreak.streak > bestStreak.streak) bestStreak = { ...currentStreak }
    }
  })

  // Shopper — highest buyingCount in a single game
  let shopper = { name: '', buyings: 0 }
  games.forEach(g => {
    ;(g.results as Result[]).filter(r => !r.isOther).forEach(r => {
      if (r.buyingCount > shopper.buyings) shopper = { name: r.name, buyings: r.buyingCount }
    })
  })

  // All time record — highest washoutChips in a single game
  let allTimeRecord = { name: '', chips: 0 }
  games.forEach(g => {
    ;(g.results as Result[]).filter(r => !r.isOther).forEach(r => {
      const chips = Math.round(r.normalizedWashoutChips || r.washoutChips || 0)
      if (chips > allTimeRecord.chips) allTimeRecord = { name: r.name, chips }
    })
  })

  return (
    <div style={{ maxWidth: 540, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
        <BackBtn onClick={onBack} label="Home" />
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Tournament ranking</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: T.textDim }}>{games.length} game{games.length !== 1 ? 's' : ''}</span>
      </div>

      {loading && <p style={{ color: T.textMuted, textAlign: 'center', padding: '2rem' }}>Loading...</p>}

      {!loading && games.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem 1rem' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🏆</div>
          <p style={{ fontWeight: 500, margin: '0 0 6px', color: T.text }}>No games yet</p>
          <p style={{ color: T.textMuted, fontSize: 14 }}>Rankings appear once you record some games.</p>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: '1.25rem' }}>
            <MetricCard label="Games played" value={games.length} />
            <MetricCard label="Players" value={rankings.length} />
            <MetricCard label="Total pot" value={`\u20ac${games.reduce((s, g) => s + (g.summary as Summary).totalInvestedEuro, 0)}`} />
          </div>

          {/* Fun stats */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: '1.25rem' }}>
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: '0.75rem', textAlign: 'center' }}>
              <div style={{ fontSize: 22, marginBottom: 4 }}>🔥</div>
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Win streak</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{bestStreak.name || '—'}</div>
              {bestStreak.streak > 0 && <div style={{ fontSize: 12, color: T.accent, fontWeight: 600 }}>{bestStreak.streak} in a row</div>}
            </div>
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: '0.75rem', textAlign: 'center' }}>
              <div style={{ fontSize: 22, marginBottom: 4 }}>🛒</div>
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Shopper</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{shopper.name || '—'}</div>
              {shopper.buyings > 0 && <div style={{ fontSize: 12, color: T.accent, fontWeight: 600 }}>{shopper.buyings} buy-ins</div>}
            </div>
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: '0.75rem', textAlign: 'center' }}>
              <div style={{ fontSize: 22, marginBottom: 4 }}>💰</div>
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>All-time record</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{allTimeRecord.name || '—'}</div>
              {allTimeRecord.chips > 0 && <div style={{ fontSize: 12, color: T.accent, fontWeight: 600 }}>{allTimeRecord.chips} chips</div>}
            </div>
          </div>

          {/* Most committed players */}
          {rankings.length > 0 && (
            <Card style={{ marginBottom: '1.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 20 }}>🎖️</span>
                <p style={{ fontSize: 13, fontWeight: 600, margin: 0, color: T.text }}>Most Committed</p>
              </div>
              {[...rankings].sort((a, b) => b.games - a.games).slice(0, 5).map((p, i) => {
                const pct = games.length > 0 ? Math.round((p.games / games.length) * 100) : 0
                return (
                  <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: i < Math.min(rankings.length, 5) - 1 ? `1px solid ${T.border}` : 'none' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: T.textDim, width: 20 }}>{i + 1}</span>
                    <span style={{ fontSize: 14, fontWeight: 500, color: T.text, flex: 1 }}>{p.name}</span>
                    <span style={{ fontSize: 12, color: T.textMuted }}>{p.games}/{games.length} games</span>
                    <div style={{ width: 60, height: 6, background: T.border, borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: T.accent, borderRadius: 3 }} />
                    </div>
                    <span style={{ fontSize: 11, color: T.accent, fontWeight: 600, width: 35, textAlign: 'right' }}>{pct}%</span>
                  </div>
                )
              })}
            </Card>
          )}

          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {['#', 'Player', 'Games', 'Wins', 'Total'].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: h === 'Total' ? 'right' : h === 'Games' || h === 'Wins' ? 'center' : 'left', fontWeight: 500, color: T.textDim, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rankings.map((p, i) => (
                  <tr key={p.name} style={{ borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ padding: '10px 12px', fontWeight: 600, color: T.textDim }}>{medals[i] || i + 1}</td>
                    <td style={{ padding: '10px 12px', fontWeight: 500, color: T.text }}>{p.name}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'center', color: T.textMuted }}>{p.games}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'center', color: T.textMuted }}>{p.wins}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <span style={{ background: p.totalNet > 0 ? T.greenBg : p.totalNet < 0 ? T.redBg : 'transparent', color: p.totalNet > 0 ? T.greenText : p.totalNet < 0 ? T.redText : T.text, padding: '3px 10px', borderRadius: 20, fontWeight: 600, fontSize: 13, display: 'inline-block', lineHeight: '1.4', verticalAlign: 'middle' }}>
                        {p.totalNet >= 0 ? '+' : ''}&euro;{p.totalNet}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ── Screen: Personal Analysis ────────────────────────────────────────────────
function AnalysisScreen({ games, registry, onBack }: { games: GameRecord[]; registry: RegisteredPlayer[]; onBack: () => void }) {
  const [selectedPlayer, setSelectedPlayer] = useState<string>('')

  // Get all unique player names from games (use registryId where available, fall back to name)
  const allPlayers: { key: string; name: string }[] = []
  const seen = new Set<string>()
  games.forEach(g => {
    ;(g.results as Result[]).filter(r => !r.isOther).forEach(r => {
      const key = r.registryId || `name:${r.name.trim().toLowerCase()}`
      if (!seen.has(key)) { seen.add(key); allPlayers.push({ key, name: r.name }) }
    })
  })
  allPlayers.sort((a, b) => a.name.localeCompare(b.name))

  // Get data points for selected player
  const sortedGames = [...games].sort((a, b) => ((a.game_date || a.gameDate) || '').localeCompare((b.game_date || b.gameDate) || ''))
  const dataPoints: { date: string; label: string; value: number }[] = []
  if (selectedPlayer) {
    sortedGames.forEach(g => {
      const r = (g.results as Result[]).find(r => {
        const key = r.registryId || `name:${r.name.trim().toLowerCase()}`
        return key === selectedPlayer
      })
      if (r) {
        const pokerNet = Math.round(r.pokerCashoutEuro - r.investedEuro)
        const date = g.game_date || g.gameDate || ''
        const label = formatGameDate(date) || date
        dataPoints.push({ date, label, value: pokerNet })
      }
    })
  }

  // Cumulative data
  let cumulative = 0
  const cumulativePoints = dataPoints.map(d => { cumulative += d.value; return { ...d, cumValue: cumulative } })

  // Chart dimensions
  const W = 500, H = 250, PAD_L = 50, PAD_R = 20, PAD_T = 20, PAD_B = 40
  const chartW = W - PAD_L - PAD_R
  const chartH = H - PAD_T - PAD_B

  const values = cumulativePoints.map(d => d.cumValue)
  const minV = values.length ? Math.min(0, ...values) : -10
  const maxV = values.length ? Math.max(0, ...values) : 10
  const range = maxV - minV || 1

  const toX = (i: number) => PAD_L + (cumulativePoints.length > 1 ? (i / (cumulativePoints.length - 1)) * chartW : chartW / 2)
  const toY = (v: number) => PAD_T + chartH - ((v - minV) / range) * chartH
  const zeroY = toY(0)

  const linePath = cumulativePoints.map((d, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(d.cumValue).toFixed(1)}`).join(' ')
  const areaPath = linePath + (cumulativePoints.length > 0 ? ` L${toX(cumulativePoints.length - 1).toFixed(1)},${zeroY.toFixed(1)} L${toX(0).toFixed(1)},${zeroY.toFixed(1)} Z` : '')

  const playerName = allPlayers.find(p => p.key === selectedPlayer)?.name || ''

  return (
    <div style={{ maxWidth: 580, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
        <BackBtn onClick={onBack} label="Home" />
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Personal Analysis</h2>
      </div>

      <Card style={{ marginBottom: '1.25rem' }}>
        <p style={{ fontSize: 12, color: T.textMuted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 }}>Select player</p>
        <select value={selectedPlayer} onChange={e => setSelectedPlayer(e.target.value)} style={{ width: '100%', padding: '10px 12px', fontSize: 15, borderRadius: 8, border: `1px solid ${T.border}`, background: '#f0f0f5', color: T.text, outline: 'none', cursor: 'pointer' }}>
          <option value="">— Choose a player —</option>
          {allPlayers.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
        </select>
      </Card>

      {selectedPlayer && cumulativePoints.length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
          <p style={{ color: T.textMuted, fontSize: 14 }}>No games found for this player.</p>
        </div>
      )}

      {selectedPlayer && cumulativePoints.length > 0 && (
        <>
          {/* Summary stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: '1.25rem' }}>
            <MetricCard label="Games" value={cumulativePoints.length} />
            <MetricCard label="Total P&L" value={`${cumulative >= 0 ? '+' : ''}€${cumulative}`} />
            <MetricCard label="Best game" value={`€${Math.max(...dataPoints.map(d => d.value))}`} />
          </div>

          {/* Trend & encouragement */}
          {(() => {
            const n = dataPoints.length
            const wins = dataPoints.filter(d => d.value > 0).length
            const losses = dataPoints.filter(d => d.value < 0).length
            const winRate = n > 0 ? Math.round((wins / n) * 100) : 0
            const recent3 = dataPoints.slice(-3)
            const recentSum = recent3.reduce((s, d) => s + d.value, 0)
            const recentWins = recent3.filter(d => d.value > 0).length
            const bestGame = Math.max(...dataPoints.map(d => d.value))
            const worstGame = Math.min(...dataPoints.map(d => d.value))
            const avgResult = n > 0 ? Math.round(dataPoints.reduce((s, d) => s + d.value, 0) / n) : 0

            let trend = ''
            let emoji = ''
            if (n < 2) { trend = 'Just getting started — too early to spot a trend.'; emoji = '🎯' }
            else if (recentWins === 3) { trend = 'On fire! Won the last 3 games in a row.'; emoji = '🔥' }
            else if (recentWins >= 2) { trend = 'Strong recent form — winning most recent games.'; emoji = '📈' }
            else if (recentSum > 0) { trend = 'Trending upward lately — recent games are positive.'; emoji = '📈' }
            else if (recent3.every(d => d.value < 0)) { trend = 'Tough stretch — last 3 games were losses. Turnaround coming?'; emoji = '💪' }
            else if (recentSum < 0) { trend = 'Recent results are slightly down, but the tide can turn.'; emoji = '🌊' }
            else { trend = 'Steady play — mixing wins and losses evenly.'; emoji = '⚖️' }

            let status = ''
            if (cumulative > 50) status = `Up €${cumulative} overall — solid profit. `
            else if (cumulative > 0) status = `Slightly in the green at +€${cumulative}. `
            else if (cumulative === 0) status = 'Perfectly break-even — the poker gods are watching. '
            else if (cumulative > -50) status = `Just €${Math.abs(cumulative)} in the red — one good night away from profit. `
            else status = `Down €${Math.abs(cumulative)} overall, but every session is a fresh start. `

            let encouragement = ''
            if (winRate >= 60) encouragement = `With a ${winRate}% win rate, you're one of the sharpest at the table. Keep reading those hands! 🃏`
            else if (winRate >= 40) encouragement = `${winRate}% win rate — right in the mix. A few key hands could tip the balance your way. 👊`
            else if (n >= 3) encouragement = `${winRate}% win rate so far — remember, variance is part of the game. Your breakthrough session is coming! 🎰`
            else encouragement = 'Still early days — keep playing, keep learning, and the results will follow! 🚀'

            return (
              <Card style={{ marginBottom: '1.25rem', background: `linear-gradient(135deg, ${cumulative >= 0 ? '#f0fdf4' : '#fef7f0'}, ${T.surface})` }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <span style={{ fontSize: 28, flexShrink: 0 }}>{emoji}</span>
                  <div>
                    <p style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600, color: T.text }}>{playerName}&apos;s Overview</p>
                    <p style={{ margin: '0 0 4px', fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
                      {status}{trend}
                    </p>
                    <p style={{ margin: '4px 0 0', fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
                      Avg result per game: <strong style={{ color: avgResult >= 0 ? T.greenText : T.redText }}>{avgResult >= 0 ? '+' : ''}€{avgResult}</strong> · Best: <strong style={{ color: T.greenText }}>+€{bestGame}</strong> · Worst: <strong style={{ color: T.redText }}>€{worstGame}</strong>
                    </p>
                    <p style={{ margin: '8px 0 0', fontSize: 13, color: T.accent, fontStyle: 'italic' }}>{encouragement}</p>
                  </div>
                </div>
              </Card>
            )
          })()}

          {/* Per-game +/- bar chart */}
          <Card style={{ marginBottom: '1.25rem', padding: '1rem' }}>
            <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px', color: T.text }}>{playerName} — Per Game P&L</p>
            {(() => {
              const BW = 500, BH = 200, B_PAD_L = 45, B_PAD_R = 10, B_PAD_T = 15, B_PAD_B = 45
              const bChartW = BW - B_PAD_L - B_PAD_R
              const bChartH = BH - B_PAD_T - B_PAD_B
              const barVals = dataPoints.map(d => d.value)
              const bMin = Math.min(0, ...barVals)
              const bMax = Math.max(0, ...barVals)
              const bRange = bMax - bMin || 1
              const barW = Math.min(30, (bChartW / dataPoints.length) * 0.7)
              const gap = bChartW / dataPoints.length
              const bToY = (v: number) => B_PAD_T + bChartH - ((v - bMin) / bRange) * bChartH
              const bZeroY = bToY(0)
              return (
                <svg viewBox={`0 0 ${BW} ${BH}`} style={{ width: '100%', height: 'auto' }}>
                  {[0, 0.25, 0.5, 0.75, 1].map(f => {
                    const v = bMin + f * bRange
                    const y = bToY(v)
                    return <g key={f}><line x1={B_PAD_L} y1={y} x2={BW - B_PAD_R} y2={y} stroke={T.border} strokeWidth="0.5" /><text x={B_PAD_L - 6} y={y + 3} textAnchor="end" fill={T.textDim} fontSize="9">€{Math.round(v)}</text></g>
                  })}
                  <line x1={B_PAD_L} y1={bZeroY} x2={BW - B_PAD_R} y2={bZeroY} stroke={T.textDim} strokeWidth="1" strokeDasharray="3,2" />
                  {dataPoints.map((d, i) => {
                    const x = B_PAD_L + gap * i + (gap - barW) / 2
                    const y = d.value >= 0 ? bToY(d.value) : bZeroY
                    const h = Math.abs(bToY(d.value) - bZeroY)
                    return <g key={i}>
                      <rect x={x} y={y} width={barW} height={Math.max(h, 1)} rx={2} fill={d.value >= 0 ? T.green : T.red} opacity={0.8} />
                      <text x={x + barW / 2} y={BH - 6} textAnchor="middle" fill={T.textDim} fontSize="8" transform={`rotate(-40,${x + barW / 2},${BH - 6})`}>{formatShortDate(d.date)}</text>
                    </g>
                  })}
                </svg>
              )
            })()}
          </Card>

          {/* Cumulative P&L chart */}
          <Card style={{ marginBottom: '1.25rem', padding: '1rem' }}>
            <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px', color: T.text }}>{playerName} — Cumulative P&L</p>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
              {[0, 0.25, 0.5, 0.75, 1].map(f => {
                const v = minV + f * range
                const y = toY(v)
                return <g key={f}>
                  <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke={T.border} strokeWidth="1" />
                  <text x={PAD_L - 8} y={y + 4} textAnchor="end" fill={T.textDim} fontSize="10">€{Math.round(v)}</text>
                </g>
              })}
              <line x1={PAD_L} y1={zeroY} x2={W - PAD_R} y2={zeroY} stroke={T.textDim} strokeWidth="1" strokeDasharray="4,3" />
              {cumulativePoints.length > 1 && <path d={areaPath} fill={cumulative >= 0 ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)'} />}
              {cumulativePoints.length > 1 && <path d={linePath} fill="none" stroke={cumulative >= 0 ? T.green : T.red} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
              {cumulativePoints.map((d, i) => (
                <g key={i}>
                  <circle cx={toX(i)} cy={toY(d.cumValue)} r="4" fill={d.cumValue >= 0 ? T.green : T.red} stroke={T.surface} strokeWidth="2" />
                  {(i === 0 || i === cumulativePoints.length - 1 || (cumulativePoints.length <= 8) || (i % Math.ceil(cumulativePoints.length / 5) === 0)) && (
                    <text x={toX(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === cumulativePoints.length - 1 ? 'end' : 'middle'} fill={T.textDim} fontSize="9" transform={`rotate(-30,${toX(i)},${H - 8})`}>
                      {formatShortDate(d.date)}
                    </text>
                  )}
                </g>
              ))}
              {cumulativePoints.length === 1 && <circle cx={toX(0)} cy={toY(cumulativePoints[0].cumValue)} r="6" fill={cumulativePoints[0].cumValue >= 0 ? T.green : T.red} stroke={T.surface} strokeWidth="2" />}
            </svg>
          </Card>

          {/* Game-by-game breakdown */}
          <Card>
            <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px', color: T.text }}>Game breakdown</p>
            {dataPoints.map((d, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: i < dataPoints.length - 1 ? `1px solid ${T.border}` : 'none' }}>
                <span style={{ fontSize: 13, color: T.textMuted }}>{formatShortDate(d.date)}</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: d.value >= 0 ? T.greenText : T.redText, background: d.value >= 0 ? T.greenBg : T.redBg, padding: '2px 10px', borderRadius: 20 }}>
                  {d.value >= 0 ? '+' : ''}€{d.value}
                </span>
              </div>
            ))}
          </Card>
        </>
      )}
    </div>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function PokerApp() {
  const [screen, setScreen] = useState('home')
  const [parsedData, setParsedData] = useState<any>(null)
  const [finalPlayers, setFinalPlayers] = useState<Player[] | null>(null)
  const [finalHostId, setFinalHostId] = useState<string | null>(null)
  const [finalGameDate, setFinalGameDate] = useState<string | null>(null)
  const [finalDateSource, setFinalDateSource] = useState<string | null>(null)
  const [games, setGames] = useState<GameRecord[]>([])
  const [gamesLoading, setGamesLoading] = useState(true)
  const [viewingGame, setViewingGame] = useState<GameRecord | null>(null)
  const [undoState, setUndoState] = useState<{ game: GameRecord; timeoutId: ReturnType<typeof setTimeout> } | null>(null)
  const [registry, setRegistry] = useState<RegisteredPlayer[]>([])

  useEffect(() => {
    Promise.all([
      Promise.resolve(supabase.from('games').select('*').order('game_date', { ascending: false })),
      Promise.resolve(supabase.from('players').select('*').eq('is_active', true).order('name')),
    ]).then(([gamesRes, playersRes]) => {
      if (gamesRes.data) setGames(gamesRes.data as GameRecord[])
      if (playersRes.data) setRegistry(playersRes.data as RegisteredPlayer[])
      setGamesLoading(false)
    }).catch(() => setGamesLoading(false))
  }, [])

  const [editingGameId, setEditingGameId] = useState<string | null>(null)

  const handleUpdateGame = async (record: any) => {
    if (!editingGameId) return
    const gameDate = record.gameDate || finalGameDate || new Date().toISOString().slice(0, 10)
    const dateSource = record.dateSource || finalDateSource || 'manual'
    const row = { game_date: gameDate, date_source: dateSource, summary: record.summary, results: record.results, settlements: record.settlements, players: record.players, host_id: record.hostId }
    const { data, error } = await supabase.from('games').update(row).eq('id', editingGameId).select().single()
    if (!error && data) {
      setGames(prev => prev.map(g => g.id === editingGameId ? data as GameRecord : g))
      setViewingGame(data as GameRecord)
      setEditingGameId(null)
      setScreen('view-game')
    } else {
      alert('Failed to update game. Please try again.')
    }
  }

  const handleSaveGame = async (record: any) => {
    const gameDate = record.gameDate || finalGameDate || new Date().toISOString().slice(0, 10)
    const dateSource = record.dateSource || finalDateSource || 'today'
    // Store scoresheet image inside summary JSONB (no schema change needed)
    const summary = record.previewUrl
      ? { ...record.summary, scoresheetImage: record.previewUrl }
      : record.summary
    const row: any = { game_date: gameDate, date_source: dateSource, summary, results: record.results, settlements: record.settlements, players: record.players, host_id: record.hostId }
    const { data, error } = await supabase.from('games').insert(row).select().single()
    if (error || !data) { console.error('Save failed:', error?.message); return }
    setGames(prev => [data as GameRecord, ...prev])
  }

  const handleDeleteGame = async (id: string) => {
    const deletedGame = games.find(g => g.id === id)
    if (!deletedGame) return
    // Cancel previous undo if still pending (that game is already re-inserted or cleared)
    if (undoState) clearTimeout(undoState.timeoutId)
    // Remove from UI and delete from DB immediately — refresh-safe
    setGames(prev => prev.filter(g => g.id !== id))
    await supabase.from('games').delete().eq('id', id)
    // Start undo window: clear toast after 8s
    const timeoutId = setTimeout(() => setUndoState(null), 8000)
    setUndoState({ game: deletedGame, timeoutId })
  }

  const handleUndoDelete = async () => {
    if (!undoState) return
    clearTimeout(undoState.timeoutId)
    // Re-insert the original game record with its original ID
    const g = undoState.game
    const row: any = {
      id: g.id,
      game_date: g.game_date || g.gameDate,
      date_source: g.date_source || g.dateSource,
      summary: g.summary, results: g.results, settlements: g.settlements,
      players: g.players, host_id: g.host_id || g.hostId,
    }
    if ((g as any).scoresheet_url) row.scoresheet_url = (g as any).scoresheet_url
    const { data } = await supabase.from('games').insert(row).select().single()
    const restored = (data as GameRecord) || g
    setGames(prev => [...prev, restored].sort((a, b) => ((b.game_date || b.gameDate) || '').localeCompare((a.game_date || a.gameDate) || '')))
    setUndoState(null)
  }

  const handleAddPlayer = async (name: string) => {
    const { data, error } = await supabase.from('players').insert({ name }).select().single()
    if (!error && data) setRegistry(prev => [...prev, data as RegisteredPlayer].sort((a, b) => a.name.localeCompare(b.name)))
  }
  const handleUpdatePlayer = async (id: string, name: string) => {
    const { error } = await supabase.from('players').update({ name }).eq('id', id)
    if (!error) setRegistry(prev => prev.map(p => p.id === id ? { ...p, name } : p).sort((a, b) => a.name.localeCompare(b.name)))
  }
  const handleDeletePlayer = async (id: string) => {
    const { error } = await supabase.from('players').update({ is_active: false }).eq('id', id)
    if (!error) setRegistry(prev => prev.filter(p => p.id !== id))
  }

  const handleDateChange = (date: string, source: string) => { setFinalGameDate(date); setFinalDateSource(source) }

  return (
    <div style={{ minHeight: '100vh', background: T.bg, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
      {screen === 'home' && <HomeScreen onNewGame={() => setScreen('upload')} onHistory={() => setScreen('history')} onTournament={() => setScreen('tournament')} onAnalysis={() => setScreen('analysis')} onSettings={() => setScreen('settings')} onSignOut={() => { sessionStorage.removeItem('poker-auth'); window.location.href = '/' }} />}
      {screen === 'upload' && <UploadScreen onParsed={d => { setParsedData(d); setScreen('review') }} onManual={() => { setParsedData({ players: [], warnings: [], previewUrl: null, gameDate: new Date().toISOString().slice(0, 10), dateSource: 'today' }); setScreen('review') }} onBack={() => setScreen('home')} />}
      {screen === 'review' && parsedData && <ReviewScreen {...parsedData} registry={registry} onCalculate={(players: Player[], hostId: string, gameDate: string, dateSource: string) => { setFinalPlayers(players); setFinalHostId(hostId); setFinalGameDate(gameDate); setFinalDateSource(dateSource); setScreen('results') }} onBack={() => setScreen('upload')} />}
      {screen === 'results' && finalPlayers && <ResultsScreen players={finalPlayers} hostId={finalHostId} gameDate={finalGameDate} dateSource={finalDateSource} previewUrl={parsedData?.previewUrl} onBack={() => setScreen('review')} onSave={handleSaveGame} onHome={() => setScreen('home')} onDateChange={handleDateChange} />}
      {screen === 'history' && <HistoryScreen games={games} loading={gamesLoading} onBack={() => setScreen('home')} onViewGame={g => { setViewingGame(g); setScreen('view-game') }} onDelete={handleDeleteGame} undoGame={undoState?.game || null} onUndo={handleUndoDelete} />}
      {screen === 'settings' && <SettingsScreen registry={registry} onBack={() => setScreen('home')} onAdd={handleAddPlayer} onUpdate={handleUpdatePlayer} onDelete={handleDeletePlayer} />}
      {screen === 'tournament' && <TournamentScreen games={games} loading={gamesLoading} onBack={() => setScreen('home')} />}
      {screen === 'analysis' && <AnalysisScreen games={games} registry={registry} onBack={() => setScreen('home')} />}
      {screen === 'view-game' && viewingGame && <ResultsScreen players={viewingGame.players} hostId={viewingGame.host_id || viewingGame.hostId} gameDate={viewingGame.game_date || viewingGame.gameDate} dateSource={viewingGame.date_source || viewingGame.dateSource} gameId={viewingGame.id} scoresheetUrl={(viewingGame.summary as any)?.scoresheetImage || viewingGame.scoresheet_url} onBack={() => setScreen('history')} onHome={() => setScreen('home')} onDateChange={(date: string, source: string) => {
        supabase.from('games').update({ game_date: date, date_source: source }).eq('id', viewingGame.id)
        setGames(prev => prev.map(g => g.id === viewingGame.id ? { ...g, game_date: date, gameDate: date, date_source: source, dateSource: source } : g))
        setViewingGame(prev => prev ? { ...prev, game_date: date, gameDate: date, date_source: source, dateSource: source } : prev)
      }} onEdit={() => {
        setEditingGameId(viewingGame.id)
        setParsedData({ players: viewingGame.players, warnings: [], previewUrl: null, gameDate: viewingGame.game_date || viewingGame.gameDate, dateSource: viewingGame.date_source || viewingGame.dateSource, detectedHostId: viewingGame.host_id || viewingGame.hostId })
        setScreen('edit-game')
      }} readOnly />}
      {screen === 'edit-game' && parsedData && <ReviewScreen {...parsedData} registry={registry} onCalculate={(players: Player[], hostId: string, gameDate: string, dateSource: string) => { setFinalPlayers(players); setFinalHostId(hostId); setFinalGameDate(gameDate); setFinalDateSource(dateSource); setScreen('edit-results') }} onBack={() => { setEditingGameId(null); setScreen('view-game') }} />}
      {screen === 'edit-results' && finalPlayers && <ResultsScreen players={finalPlayers} hostId={finalHostId} gameDate={finalGameDate} dateSource={finalDateSource} onBack={() => setScreen('edit-game')} onSave={async (record: any) => { await handleUpdateGame(record) }} saveLabel="✅ Update game record" onCancel={() => { setEditingGameId(null); setScreen('view-game') }} onDateChange={handleDateChange} />}
    </div>
  )
}
