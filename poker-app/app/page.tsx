'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function GatePage() {
  const [input, setInput] = useState('')
  const [error, setError] = useState(false)
  const [checking, setChecking] = useState(true)
  const router = useRouter()

  useEffect(() => {
    if (sessionStorage.getItem('poker-auth') === 'true') {
      router.replace('/game')
    } else {
      setChecking(false)
    }
  }, [router])

  const submit = () => {
    const passcode = process.env.NEXT_PUBLIC_PASSCODE
    if (input === passcode) {
      sessionStorage.setItem('poker-auth', 'true')
      router.push('/game')
    } else {
      setError(true)
      setInput('')
    }
  }

  if (checking) return null

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', padding: '2rem',
      backgroundImage: 'url(/poker-bg.png)',
      backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat',
      position: 'relative',
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(2px)',
      }} />
      <div style={{
        position: 'relative', zIndex: 1,
        background: 'rgba(15, 17, 23, 0.85)', borderRadius: 24, padding: '2.5rem 2rem',
        width: '100%', maxWidth: 380, textAlign: 'center',
        border: '1px solid rgba(255,255,255,0.1)',
        boxShadow: '0 8px 40px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(20px)',
      }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>&#9824;&#65039;</div>
        <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 6, letterSpacing: -0.5, color: '#fff' }}>
          Poker Results
        </h1>
        <p style={{ color: '#888', fontSize: 14, marginBottom: 28 }}>
          Enter the passcode to continue
        </p>

        <input
          type="password"
          value={input}
          onChange={e => { setInput(e.target.value); setError(false) }}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="Passcode"
          autoFocus
          style={{
            width: '100%', padding: '12px 16px', fontSize: 16, borderRadius: 12,
            border: error ? '1.5px solid #ef4444' : '1px solid rgba(255,255,255,0.12)',
            outline: 'none', marginBottom: 12, background: 'rgba(255,255,255,0.06)',
            textAlign: 'center', letterSpacing: '0.2em', color: '#fff',
          }}
        />

        {error && (
          <p style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>
            Wrong passcode — try again
          </p>
        )}

        <button
          onClick={submit}
          style={{
            width: '100%', padding: '13px', background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            color: '#fff', border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 600,
            cursor: 'pointer', transition: 'opacity 0.2s',
          }}
        >
          Enter
        </button>
      </div>
    </div>
  )
}
