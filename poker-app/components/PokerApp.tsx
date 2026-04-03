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

function fmt(n: number) { return Math.ceil(n) }

// ── Types ─────────────────────────────────────────────────────────────────────
type Player = { id: string; name: string; buyingCount: number; washoutChips: number; isHostDetected?: boolean; confidence?: Record<string, number> }
type Result = Player & { isHost: boolean; purchasedChips: number; investedEuro: number; normalizedWashoutChips: number; pokerCashoutEuro: number; hostFeeEuro: number; hostFeeReceivedEuro: number; netBalanceEuro: number }
type Transfer = { from: string; fromId: string; to: string; toId: string; amountEuro: number }
type Summary = { totalPlayers: number; totalBuyings: number; totalInvestedEuro: number; totalPurchasedChips: number; totalWashoutChips: number; normalizationApplied: boolean; totalHostFeePool: number; hostName: string }
type GameRecord = { id: string; players: Player[]; hostId: string; gameDate: string | null; dateSource: string | null; summary: Summary; results: Result[]; settlements: Transfer[] }

// ── Calculation ───────────────────────────────────────────────────────────────
function calculate(players: Player[], hostId: string) {
  const totalPlayers = players.length
  const totalPurchasedChips = players.reduce((s, p) => s + p.buyingCount * CHIPS_PER_BUYING, 0)
  const totalInvestedEuro = players.reduce((s, p) => s + p.buyingCount * EURO_PER_BUYING, 0)
  const totalRawWashout = players.reduce((s, p) => s + p.washoutChips, 0)
  const normalizationApplied = totalRawWashout !== totalPurchasedChips && totalRawWashout > 0
  const normFactor = normalizationApplied ? totalPurchasedChips / totalRawWashout : 1
  const totalHostFeePool = totalPlayers * HOST_FEE

  const results: Result[] = players.map((p) => {
    const purchasedChips = p.buyingCount * CHIPS_PER_BUYING
    const investedEuro = p.buyingCount * EURO_PER_BUYING
    const normalizedWashoutChips = p.washoutChips * normFactor
    const pokerCashoutEuro = (normalizedWashoutChips / totalPurchasedChips) * totalInvestedEuro
    const isHost = p.id === hostId
    const hostFeeReceivedEuro = isHost ? totalHostFeePool : 0
    const netBalanceEuro = pokerCashoutEuro - investedEuro - HOST_FEE + hostFeeReceivedEuro
    return { ...p, isHost, purchasedChips, investedEuro, normalizedWashoutChips: Math.round(normalizedWashoutChips * 100) / 100, pokerCashoutEuro, hostFeeEuro: HOST_FEE, hostFeeReceivedEuro, netBalanceEuro: Math.ceil(netBalanceEuro) }
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
    if (amount > 0) transfers.push({ from: debtor.name, fromId: debtor.id, to: creditor.name, toId: creditor.id, amountEuro: Math.ceil(amount / cs) })
    debtor.balance += amount; creditor.balance -= amount
    if (Math.abs(debtor.balance) < 1) debtors.shift()
    if (Math.abs(creditor.balance) < 1) creditors.shift()
  }
  return transfers
}

// ── OCR (calls our server-side API route) ─────────────────────────────────────
async function runOCR(base64Image: string, mimeType: string) {
  const resp = await fetch('/api/ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64Image, mimeType }),
  })
  if (!resp.ok) throw new Error(`OCR API error: ${resp.status}`)
  return resp.json()
}

// ── UI atoms ──────────────────────────────────────────────────────────────────
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: '#fff', border: '0.5px solid #e8e8e0', borderRadius: 12, padding: '1rem 1.25rem', ...style }}>{children}</div>
}

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ background: '#f5f5f0', borderRadius: 8, padding: '1rem', textAlign: 'center' }}>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
    </div>
  )
}

function BackBtn({ onClick, label = '← Back' }: { onClick: () => void; label?: string }) {
  return <button onClick={onClick} style={{ background: 'none', border: '0.5px solid #ddd', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 13 }}>{label}</button>
}

// ── Screen: Home ──────────────────────────────────────────────────────────────
function HomeScreen({ onNewGame, onHistory, onTournament, onSignOut }: { onNewGame: () => void; onHistory: () => void; onTournament: () => void; onSignOut: () => void }) {
  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '3rem 1.5rem 2rem' }}>
      <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
        <div style={{ fontSize: 56, marginBottom: 12 }}>♠️</div>
        <h1 style={{ fontFamily: 'Georgia, serif', fontSize: 32, fontWeight: 700, margin: '0 0 8px', letterSpacing: -0.5 }}>Poker Results</h1>
        <p style={{ color: '#888', fontSize: 15, margin: 0, lineHeight: 1.6 }}>Track games, calculate payouts,<br />and settle up in seconds.</p>
      </div>

      <button onClick={onNewGame} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, background: '#1D9E75', color: '#fff', border: 'none', borderRadius: 14, padding: '18px 20px', fontSize: 17, fontWeight: 700, cursor: 'pointer', marginBottom: 12 }}>
        <span style={{ fontSize: 22 }}>📷</span> New game results
      </button>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: '2.5rem' }}>
        {[{ icon: '📋', label: 'Game history', sub: 'All past games', fn: onHistory }, { icon: '🏆', label: 'Tournament', sub: 'Overall rankings', fn: onTournament }].map(item => (
          <button key={item.label} onClick={item.fn} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: '#fff', border: '0.5px solid #e0e0d8', borderRadius: 14, padding: '20px 12px', cursor: 'pointer' }}>
            <span style={{ fontSize: 28 }}>{item.icon}</span>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{item.label}</span>
            <span style={{ fontSize: 12, color: '#999' }}>{item.sub}</span>
          </button>
        ))}
      </div>

      <button onClick={onSignOut} style={{ display: 'block', margin: '0 auto', background: 'none', border: 'none', color: '#bbb', fontSize: 13, cursor: 'pointer' }}>Sign out</button>
    </div>
  )
}

// ── Screen: Upload ────────────────────────────────────────────────────────────
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
        name: (p.name || '').replace(/[*★✦]+/g, '').trim(),
        buyingCount: Math.max(1, parseInt(p.buyingCount) || 1),
        washoutChips: Math.max(0, parseInt(p.washoutChips) || 0),
        isHostDetected: !!p.isHost,
        confidence: p.confidence || {},
      }))

      let gameDate: string | null = parsed.date || null
      let dateSource: string | null = null
      if (gameDate) { dateSource = 'sheet' }
      if (!gameDate) { const exif = extractExifDate(base64); if (exif) { gameDate = exif; dateSource = 'photo' } }
      if (!gameDate && file.lastModified) { gameDate = new Date(file.lastModified).toISOString().slice(0, 10); dateSource = 'file' }
      if (!gameDate) { gameDate = new Date().toISOString().slice(0, 10); dateSource = 'today' }

      const detectedHost = players.find(p => p.isHostDetected)
      onParsed({ players, warnings: parsed.warnings || [], previewUrl, gameDate, dateSource, detectedHostId: detectedHost?.id || null })
    } catch {
      setError('Could not read the image. Try manual entry instead.')
    } finally { setLoading(false) }
  }, [onParsed])

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <div style={{ marginBottom: '1rem' }}><BackBtn onClick={onBack} label="← Home" /></div>
      <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>♠️</div>
        <h1 style={{ fontFamily: 'Georgia, serif', fontSize: 26, fontWeight: 700, margin: 0 }}>New game</h1>
        <p style={{ color: '#888', fontSize: 14, marginTop: 6 }}>Upload your score sheet photo</p>
      </div>

      <div onDragOver={e => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); processFile(e.dataTransfer.files[0]) }}
        onClick={() => inputRef.current?.click()}
        style={{ border: `2px dashed ${dragging ? '#1D9E75' : '#ccc'}`, borderRadius: 16, padding: '3rem 2rem', textAlign: 'center', cursor: 'pointer', background: dragging ? '#f0fdf7' : '#fafaf8', marginBottom: '1rem' }}>
        <input ref={inputRef} type="file" accept="image/*,.heic" style={{ display: 'none' }} onChange={e => e.target.files?.[0] && processFile(e.target.files[0])} />
        {loading ? (
          <div><div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div><p style={{ fontWeight: 500, margin: 0 }}>Reading score sheet…</p><p style={{ color: '#888', fontSize: 13, marginTop: 4 }}>This takes a few seconds</p></div>
        ) : (
          <div><div style={{ fontSize: 40, marginBottom: 12 }}>📷</div><p style={{ fontWeight: 500, margin: 0 }}>Drop a photo here, or tap to upload</p><p style={{ color: '#888', fontSize: 13, marginTop: 4 }}>JPG, PNG, WEBP — up to 15 MB</p></div>
        )}
      </div>

      {error && <div style={{ background: '#FCEBEB', color: '#A32D2D', borderRadius: 8, padding: '0.75rem 1rem', fontSize: 14, marginBottom: '1rem' }}>{error}</div>}
      <div style={{ textAlign: 'center' }}><button onClick={onManual} style={{ background: 'none', border: 'none', color: '#888', fontSize: 14, cursor: 'pointer', textDecoration: 'underline' }}>Enter results manually instead</button></div>
    </div>
  )
}

// ── Screen: Review ────────────────────────────────────────────────────────────
function ReviewScreen({ players: init, warnings, previewUrl, gameDate, dateSource, detectedHostId, onCalculate, onBack }: any) {
  const [players, setPlayers] = useState<Player[]>(init.length > 0 ? init : [{ id: generateId(), name: '', buyingCount: 1, washoutChips: 0, confidence: {} }])
  const [hostId, setHostId] = useState<string | null>(detectedHostId || null)
  const [error, setError] = useState('')

  const update = (id: string, field: string, value: any) => setPlayers(prev => prev.map(p => p.id === id ? { ...p, [field]: value } : p))
  const addRow = () => setPlayers(prev => [...prev, { id: generateId(), name: '', buyingCount: 1, washoutChips: 0, confidence: {} }])
  const removeRow = (id: string) => setPlayers(prev => prev.filter(p => p.id !== id))
  const lowConf = (p: Player, f: string) => (p.confidence?.[f] ?? 1) < 0.7

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
    setError(''); onCalculate(players, hostId, gameDate, dateSource)
  }

  const totalBuyings = players.reduce((s, p) => s + (parseInt(String(p.buyingCount)) || 0), 0)
  const totalPurchased = totalBuyings * CHIPS_PER_BUYING
  const totalCashout = players.reduce((s, p) => s + (parseInt(String(p.washoutChips)) || 0), 0)
  const balanced = totalCashout === totalPurchased

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
        <BackBtn onClick={onBack} />
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Review players</h2>
      </div>

      {previewUrl && (
        <Card style={{ marginBottom: '1rem' }}>
          <p style={{ fontSize: 12, color: '#888', margin: '0 0 8px' }}>Uploaded image</p>
          <img src={previewUrl} alt="score sheet" style={{ width: '100%', borderRadius: 8, maxHeight: 220, objectFit: 'contain' }} />
        </Card>
      )}

      {warnings.length > 0 && (
        <div style={{ background: '#FAEEDA', border: '0.5px solid #EF9F27', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1rem' }}>
          {warnings.map((w: string, i: number) => <p key={i} style={{ fontSize: 12, color: '#854F0B', margin: '2px 0' }}>⚠️ {w}</p>)}
        </div>
      )}

      <Card style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 90px 32px 60px', gap: 8, marginBottom: 8 }}>
          {['Player name', 'Buyings', 'Cashout', '', 'Host'].map(h => <span key={h} style={{ fontSize: 11, color: '#aaa', fontWeight: 500 }}>{h}</span>)}
        </div>
        {players.map(p => (
          <div key={p.id} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 90px 32px 60px', gap: 8, marginBottom: 8, alignItems: 'center' }}>
            <input value={p.name} onChange={e => update(p.id, 'name', e.target.value)} placeholder="Name"
              style={{ background: lowConf(p, 'name') ? '#FAEEDA' : '#fff', borderRadius: 6, padding: '6px 8px', fontSize: 14, border: '0.5px solid #e0e0d8', width: '100%' }} />
            <input type="number" min="1" value={p.buyingCount} onChange={e => update(p.id, 'buyingCount', parseInt(e.target.value) || 1)}
              style={{ background: lowConf(p, 'buyingCount') ? '#FAEEDA' : '#fff', borderRadius: 6, padding: '6px 8px', fontSize: 14, border: '0.5px solid #e0e0d8', width: '100%' }} />
            <input type="number" min="0" value={p.washoutChips} onChange={e => update(p.id, 'washoutChips', parseInt(e.target.value) || 0)}
              style={{ background: '#fff', borderRadius: 6, padding: '6px 8px', fontSize: 14, border: '0.5px solid #e0e0d8', width: '100%' }} />
            <button onClick={() => removeRow(p.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', fontSize: 16, padding: 0 }}>✕</button>
            <div style={{ textAlign: 'center' }}>
              <input type="radio" name="host" checked={hostId === p.id} onChange={() => setHostId(p.id)} style={{ accentColor: '#1D9E75', cursor: 'pointer', width: 16, height: 16 }} />
            </div>
          </div>
        ))}
        <button onClick={addRow} style={{ marginTop: 8, background: 'none', border: '0.5px dashed #ccc', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontSize: 13, color: '#888', width: '100%' }}>+ Add player</button>
      </Card>

      {players.length > 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: '0.75rem' }}>
            <MetricCard label="Players" value={players.length} />
            <MetricCard label="Purchased chips" value={totalPurchased} />
            <MetricCard label="Cashout chips" value={totalCashout} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: balanced ? '#EAF3DE' : '#FAEEDA', border: `0.5px solid ${balanced ? '#97C459' : '#EF9F27'}`, borderRadius: 8, padding: '10px 14px', marginBottom: '1rem', fontSize: 13 }}>
            <span>{balanced ? '✅' : '⚠️'}</span>
            {balanced
              ? <span style={{ color: '#3B6D11', fontWeight: 500 }}>Chips add up — no normalization needed.</span>
              : <span style={{ color: '#854F0B' }}><strong>Chips don&apos;t add up</strong> — cashout is {totalCashout - totalPurchased > 0 ? '+' : ''}{totalCashout - totalPurchased} vs purchased. Payouts will be normalized automatically.</span>}
          </div>
        </>
      )}

      {error && <div style={{ background: '#FCEBEB', color: '#A32D2D', borderRadius: 8, padding: '0.75rem 1rem', fontSize: 14, marginBottom: '1rem' }}>{error}</div>}
      <button onClick={handleCalculate} style={{ width: '100%', background: '#1D9E75', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontSize: 16, fontWeight: 600, cursor: 'pointer' }}>Calculate payouts →</button>
    </div>
  )
}

// ── Screen: Results ───────────────────────────────────────────────────────────
function ResultsScreen({ players, hostId, gameDate: initDate, dateSource: initSource, onBack, onSave, onHome, onDateChange, readOnly }: any) {
  const { summary, results, settlements } = calculate(players, hostId)
  const [imgStatus, setImgStatus] = useState('idle')
  const [gameDate, setGameDate] = useState<string | null>(initDate)
  const [dateSource, setDateSource] = useState<string | null>(initSource)
  const [editingDate, setEditingDate] = useState(false)
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

  const handleDateChange = (val: string) => { setGameDate(val); setDateSource('manual'); onDateChange?.(val, 'manual') }

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

  const sourceLabels: Record<string, [string, string, string]> = {
    sheet: ['Read from sheet', '#185FA5', '#E6F1FB'],
    photo: ['From photo metadata', '#854F0B', '#FAEEDA'],
    file: ['From file date', '#5F5E5A', '#F1EFE8'],
    today: ["Today's date", '#5F5E5A', '#F1EFE8'],
    manual: ['Manually set', '#3B6D11', '#EAF3DE'],
  }


  const POKER_TIPS = [
    "Fold more preflop. Most losing players play too many hands — tighten up and watch your losses shrink.",
    "Position is everything. Playing in position (acting last) gives you more information and more power every hand.",
    "Don't chase draws without pot odds. If the pot doesn't justify the call, let it go.",
    "Your buy-in is gone the moment you put it in. Never play scared money — make decisions based on the pot, not your wallet.",
    "Bluff less than you think you should. Most amateur games are full of callers. Save your bluffs for the right spots.",
    "Pay attention even when you're not in the hand. Reads and patterns are built over every hand, not just yours.",
    "Tilt is your biggest enemy. One bad beat doesn't mean your luck changes — stick to your game.",
    "Never slow-play the nuts in a multiway pot. Build the pot now, or someone rivers a free hand against you.",
    "3-bet your premium hands. Limping with aces and kings is a trap for you, not them.",
    "If you can't spot the fish at the table, it might be you — and that\'s okay, keep learning.",
    "Bet for value when you're ahead. Checking to 'trap' usually just gives free cards to your opponents.",
    "A good fold is as valuable as a good call. The best players know when to let go.",
    "Don't play big pots with marginal hands. Save your chips for when you're clearly ahead.",
    "Mixed games teach you more about poker than hold'em alone ever will.",
    "The money you save on bad calls is just as real as the money you win on good bets.",
  ]
  const tipIndex = Math.abs(results.reduce((s: number, r: Result) => s + r.netBalanceEuro, 0) + results.length * 7) % POKER_TIPS.length
  const tip = POKER_TIPS[tipIndex]

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <div ref={cardRef} style={{ background: '#fff', padding: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
          <BackBtn onClick={onBack} label="← Edit" />
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Final results</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
              {editingDate ? (
                <input type="date" value={gameDate || ''} autoFocus onChange={e => handleDateChange(e.target.value)} onBlur={() => setEditingDate(false)}
                  style={{ fontSize: 13, border: '0.5px solid #ccc', borderRadius: 6, padding: '3px 8px' }} />
              ) : (
                <button onClick={() => setEditingDate(true)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <p style={{ margin: 0, fontSize: 13, color: '#888' }}>🗓 {gameDate ? formatGameDate(gameDate) : 'Set date'}</p>
                  <span style={{ fontSize: 11, color: '#ccc' }}>✏️</span>
                </button>
              )}
              {dateSource && !editingDate && (() => {
                const [label, color, bg] = sourceLabels[dateSource] || ['Unknown', '#888', '#f5f5f0']
                return <span style={{ fontSize: 11, background: bg, color, padding: '2px 8px', borderRadius: 20, fontWeight: 500, display: 'inline-block', lineHeight: '1.4', verticalAlign: 'middle' }}>{label}</span>
              })()}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: '1.25rem' }}>
          <MetricCard label="Players" value={summary.totalPlayers} />
          <MetricCard label="Total buyings" value={summary.totalBuyings} />
          <MetricCard label="Pot size" value={`€${summary.totalInvestedEuro}`} />
          <MetricCard label="Host fee pool" value={`€${summary.totalHostFeePool}`} />
          <MetricCard label="Host" value={summary.hostName} />
        </div>

        {summary.normalizationApplied && (
          <div style={{ background: '#FAEEDA', border: '0.5px solid #EF9F27', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: 13, color: '#854F0B' }}>
            ⚠️ Cashout chips ({summary.totalWashoutChips}) didn&apos;t match purchased chips ({summary.totalPurchasedChips}). Results normalized automatically.
          </div>
        )}

        <Card style={{ marginBottom: '1.25rem', overflowX: 'auto' }}>
          <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 12px' }}>Player results</p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '0.5px solid #e8e8e0' }}>
                {['Player', 'Host', 'Buyings', 'Invested', 'Chips', 'Poker cashout', 'Host fee', 'Net balance'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500, color: '#888', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(() => {
                const maxNet = Math.max(...results.map((r: Result) => r.netBalanceEuro))
                return results.map((r: Result) => {
                  const net = r.netBalanceEuro
                  const isWinner = net === maxNet && net > 0
                  const netColor = net > 0 ? '#3B6D11' : net < 0 ? '#A32D2D' : '#1a1a1a'
                  const netBg = net > 0 ? '#EAF3DE' : net < 0 ? '#FCEBEB' : 'transparent'
                  return (
                    <tr key={r.id} style={{ borderBottom: '0.5px solid #e8e8e0' }}>
                      <td style={{ padding: '8px 8px' }}>{r.name}{isWinner && <span style={{ fontSize: 16, marginLeft: 6 }}>🥇</span>}</td>
                      <td style={{ padding: '8px 8px', textAlign: 'center' }}>{r.isHost ? '⭐' : ''}</td>
                      <td style={{ padding: '8px 8px' }}>{r.buyingCount}</td>
                      <td style={{ padding: '8px 8px' }}>€{fmt(r.investedEuro)}</td>
                      <td style={{ padding: '8px 8px' }}>{Math.round(r.normalizedWashoutChips)}</td>
                      <td style={{ padding: '8px 8px' }}>€{fmt(r.pokerCashoutEuro)}</td>
                      <td style={{ padding: '8px 8px' }}>{r.isHost ? <span style={{ color: '#3B6D11' }}>+€{fmt(r.hostFeeReceivedEuro)}</span> : `-€${fmt(r.hostFeeEuro)}`}</td>
                      <td style={{ padding: '8px 8px' }}>
                        <span style={{ background: netBg, color: netColor, padding: '3px 10px', borderRadius: 20, fontWeight: 500, whiteSpace: 'nowrap', display: 'inline-block', lineHeight: '1.4', verticalAlign: 'middle' }}>
                          {net >= 0 ? '+' : ''}€{fmt(net)}
                        </span>
                      </td>
                    </tr>
                  )
                })
              })()}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '1.5px solid #ccc', background: '#f5f5f0' }}>
                <td style={{ padding: '8px 8px', fontWeight: 500 }}>Totals</td>
                <td></td>
                <td style={{ padding: '8px 8px', fontWeight: 500 }}>{results.reduce((s: number, r: Result) => s + r.buyingCount, 0)}</td>
                <td style={{ padding: '8px 8px', fontWeight: 500 }}>€{fmt(results.reduce((s: number, r: Result) => s + r.investedEuro, 0))}</td>
                <td style={{ padding: '8px 8px', fontWeight: 500 }}>{results.reduce((s: number, r: Result) => s + Math.round(r.normalizedWashoutChips), 0)}</td>
                <td style={{ padding: '8px 8px', fontWeight: 500 }}>€{fmt(results.reduce((s: number, r: Result) => s + r.pokerCashoutEuro, 0))}</td>
                <td style={{ padding: '8px 8px', fontWeight: 500 }}>€{fmt(results.reduce((s: number, r: Result) => s + r.hostFeeReceivedEuro - r.hostFeeEuro, 0))}</td>
                <td style={{ padding: '8px 8px', fontWeight: 500 }}>€{fmt(results.reduce((s: number, r: Result) => s + r.netBalanceEuro, 0))}</td>
              </tr>
            </tfoot>
          </table>
        </Card>

        <Card style={{ marginBottom: '1.25rem' }}>
          <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 12px' }}>Settlement — {settlements.length} transfer{settlements.length !== 1 ? 's' : ''}</p>
          {settlements.length === 0 ? (
            <p style={{ color: '#888', fontSize: 14 }}>Everyone is settled — no transfers needed! 🎉</p>
          ) : settlements.map((s: Transfer, i: number) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: i < settlements.length - 1 ? '0.5px solid #e8e8e0' : 'none' }}>
              <span style={{ fontWeight: 500 }}>{s.to}</span>
              <span style={{ color: '#aaa' }}>receives from</span>
              <span style={{ fontWeight: 500 }}>{s.from}</span>
              <span style={{ marginLeft: 'auto', background: '#EAF3DE', color: '#3B6D11', padding: '4px 12px', borderRadius: 20, fontWeight: 600, fontSize: 14, display: 'inline-block', lineHeight: '1.4', verticalAlign: 'middle' }}>€{fmt(s.amountEuro)}</span>
            </div>
          ))}
        </Card>

      <button onClick={handleShare} disabled={imgStatus === 'loading'}
        style={{ width: '100%', marginTop: '1rem', background: imgStatus === 'copied' || imgStatus === 'downloaded' ? '#3B6D11' : '#185FA5', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontSize: 16, fontWeight: 600, cursor: imgStatus === 'loading' ? 'wait' : 'pointer' }}>
        {imgStatus === 'loading' && '⏳ Generating image…'}
        {imgStatus === 'copied' && '✓ Image copied — paste in WhatsApp!'}
        {imgStatus === 'downloaded' && '✓ Image saved — share from your photos!'}
        {imgStatus === 'error' && '⚠️ Could not generate image'}
        {imgStatus === 'idle' && '📸 Save as image to share'}
      </button>


      {/* Poker pro tip — inside captured area */}
      <div style={{ margin: '1.25rem 0 0', borderTop: '0.5px solid #e8e8e0', paddingTop: '1rem', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 22, flexShrink: 0 }}>🃏</span>
        <div>
          <p style={{ margin: '0 0 3px', fontSize: 11, fontWeight: 600, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Pro tip</p>
          <p style={{ margin: 0, fontSize: 13, color: '#555', lineHeight: 1.6, fontStyle: 'italic' }}>{tip}</p>
        </div>
      </div>

      </div>{/* end cardRef */}

      {!readOnly && onSave && (
        <button onClick={() => { onSave({ players, hostId, gameDate, dateSource, summary, results, settlements }); onHome?.() }}
          style={{ width: '100%', marginTop: 10, background: 'none', border: '0.5px solid #ddd', borderRadius: 10, padding: '13px', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>
          💾 Save game & go home
        </button>
      )}
      {(readOnly || !onSave) && onHome && (
        <button onClick={onHome} style={{ width: '100%', marginTop: 10, background: 'none', border: '0.5px solid #ddd', borderRadius: 10, padding: '13px', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>← Home</button>
      )}
    </div>
  )
}

// ── Screen: History ───────────────────────────────────────────────────────────
function HistoryScreen({ games, loading, onBack, onViewGame }: { games: GameRecord[]; loading: boolean; onBack: () => void; onViewGame: (g: GameRecord) => void }) {
  return (
    <div style={{ maxWidth: 540, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
        <BackBtn onClick={onBack} label="← Home" />
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Game history</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#aaa' }}>{games.length} game{games.length !== 1 ? 's' : ''}</span>
      </div>
      {loading && <p style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>Loading…</p>}
      {!loading && games.length === 0 && (
        <div style={{ textAlign: 'center', padding: '4rem 1rem' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🃏</div>
          <p style={{ fontWeight: 500, margin: '0 0 6px' }}>No games yet</p>
          <p style={{ color: '#888', fontSize: 14 }}>Completed games will appear here.</p>
        </div>
      )}
      {[...games].reverse().map((g, i) => {
        const winner = [...(g.results as Result[])].sort((a, b) => b.netBalanceEuro - a.netBalanceEuro)[0]
        return (
          <div key={g.id} onClick={() => onViewGame(g)} style={{ background: '#fff', border: '0.5px solid #e8e8e0', borderRadius: 12, padding: '1rem 1.25rem', marginBottom: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{g.gameDate ? formatGameDate(g.gameDate) : `Game ${games.length - i}`}</div>
              <div style={{ fontSize: 12, color: '#888' }}>
                {(g.summary as Summary).totalPlayers} players · €{(g.summary as Summary).totalInvestedEuro} pot{winner && <span> · 🥇 {winner.name}</span>}
              </div>
            </div>
            <span style={{ color: '#ccc', fontSize: 18 }}>›</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Screen: Tournament ────────────────────────────────────────────────────────
function TournamentScreen({ games, loading, onBack }: { games: GameRecord[]; loading: boolean; onBack: () => void }) {
  const playerMap: Record<string, { name: string; games: number; totalNet: number; wins: number }> = {}
  games.forEach(g => {
    ;(g.results as Result[]).forEach(r => {
      const key = r.name.trim().toLowerCase()
      if (!playerMap[key]) playerMap[key] = { name: r.name, games: 0, totalNet: 0, wins: 0 }
      playerMap[key].games += 1
      playerMap[key].totalNet += r.netBalanceEuro
    })
    const winner = [...(g.results as Result[])].sort((a, b) => b.netBalanceEuro - a.netBalanceEuro)[0]
    if (winner) { const key = winner.name.trim().toLowerCase(); if (playerMap[key]) playerMap[key].wins += 1 }
  })
  const rankings = Object.values(playerMap).sort((a, b) => b.totalNet - a.totalNet)
  const medals = ['🥇', '🥈', '🥉']

  return (
    <div style={{ maxWidth: 540, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
        <BackBtn onClick={onBack} label="← Home" />
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Tournament ranking</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#aaa' }}>{games.length} game{games.length !== 1 ? 's' : ''}</span>
      </div>

      {loading && <p style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>Loading…</p>}

      {!loading && games.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem 1rem' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🏆</div>
          <p style={{ fontWeight: 500, margin: '0 0 6px' }}>No games yet</p>
          <p style={{ color: '#888', fontSize: 14 }}>Rankings appear once you record some games.</p>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: '1.25rem' }}>
            <MetricCard label="Games played" value={games.length} />
            <MetricCard label="Players" value={rankings.length} />
            <MetricCard label="Total pot" value={`€${games.reduce((s, g) => s + (g.summary as Summary).totalInvestedEuro, 0)}`} />
          </div>
          <div style={{ background: '#fff', border: '0.5px solid #e8e8e0', borderRadius: 12, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ background: '#f5f5f0', borderBottom: '0.5px solid #e8e8e0' }}>
                  {['#', 'Player', 'Games', 'Wins', 'Total'].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: h === 'Total' ? 'right' : h === 'Games' || h === 'Wins' ? 'center' : 'left', fontWeight: 500, color: '#888', fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rankings.map((p, i) => (
                  <tr key={p.name} style={{ borderBottom: '0.5px solid #e8e8e0' }}>
                    <td style={{ padding: '10px 12px', fontWeight: 600, color: '#aaa' }}>{medals[i] || i + 1}</td>
                    <td style={{ padding: '10px 12px', fontWeight: 500 }}>{p.name}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'center', color: '#888' }}>{p.games}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'center', color: '#888' }}>{p.wins}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <span style={{ background: p.totalNet > 0 ? '#EAF3DE' : p.totalNet < 0 ? '#FCEBEB' : 'transparent', color: p.totalNet > 0 ? '#3B6D11' : p.totalNet < 0 ? '#A32D2D' : '#1a1a1a', padding: '3px 10px', borderRadius: 20, fontWeight: 600, fontSize: 13, display: 'inline-block', lineHeight: '1.4', verticalAlign: 'middle' }}>
                        {p.totalNet >= 0 ? '+' : ''}€{p.totalNet}
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

  // Load games from Supabase on mount
  useEffect(() => {
    Promise.resolve(supabase.from('games').select('*').order('game_date', { ascending: false }))
      .then(({ data }) => { if (data) setGames(data as GameRecord[]); setGamesLoading(false) })
      .catch(() => setGamesLoading(false))
  }, [])

  const handleSaveGame = async (record: any) => {
    const row = { game_date: record.gameDate, date_source: record.dateSource, summary: record.summary, results: record.results, settlements: record.settlements, players: record.players, host_id: record.hostId }
    const { data, error } = await supabase.from('games').insert(row).select().single()
    if (!error && data) setGames(prev => [data as GameRecord, ...prev])
  }

  const handleDateChange = (date: string, source: string) => { setFinalGameDate(date); setFinalDateSource(source) }

  return (
    <div style={{ minHeight: '100vh', background: '#f9f9f7', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      {screen === 'home' && <HomeScreen onNewGame={() => setScreen('upload')} onHistory={() => setScreen('history')} onTournament={() => setScreen('tournament')} onSignOut={() => { sessionStorage.removeItem('poker-auth'); window.location.href = '/' }} />}
      {screen === 'upload' && <UploadScreen onParsed={d => { setParsedData(d); setScreen('review') }} onManual={() => { setParsedData({ players: [], warnings: [], previewUrl: null, gameDate: new Date().toISOString().slice(0, 10), dateSource: 'today' }); setScreen('review') }} onBack={() => setScreen('home')} />}
      {screen === 'review' && parsedData && <ReviewScreen {...parsedData} onCalculate={(players: Player[], hostId: string, gameDate: string, dateSource: string) => { setFinalPlayers(players); setFinalHostId(hostId); setFinalGameDate(gameDate); setFinalDateSource(dateSource); setScreen('results') }} onBack={() => setScreen('upload')} />}
      {screen === 'results' && finalPlayers && <ResultsScreen players={finalPlayers} hostId={finalHostId} gameDate={finalGameDate} dateSource={finalDateSource} onBack={() => setScreen('review')} onSave={handleSaveGame} onHome={() => setScreen('home')} onDateChange={handleDateChange} />}
      {screen === 'history' && <HistoryScreen games={games} loading={gamesLoading} onBack={() => setScreen('home')} onViewGame={g => { setViewingGame(g); setScreen('view-game') }} />}
      {screen === 'tournament' && <TournamentScreen games={games} loading={gamesLoading} onBack={() => setScreen('home')} />}
      {screen === 'view-game' && viewingGame && <ResultsScreen players={viewingGame.players} hostId={viewingGame.host_id} gameDate={viewingGame.game_date} dateSource={viewingGame.date_source} onBack={() => setScreen('history')} onHome={() => setScreen('home')} readOnly />}
    </div>
  )
}
