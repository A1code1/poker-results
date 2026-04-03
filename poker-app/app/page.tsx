'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function GatePage() {
  const [input, setInput] = useState('')
  const [error, setError] = useState(false)
  const [checking, setChecking] = useState(true)
  const router = useRouter()

  useEffect(() => {
    // If already authed this session, skip straight to app
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
      background: '#f9f9f7',
    }}>
      <div style={{
        background: '#fff', borderRadius: 20, padding: '2.5rem 2rem',
        width: '100%', maxWidth: 380, textAlign: 'center',
        border: '0.5px solid #e0e0d8', boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
      }}>
        <div style={{ fontSize: 52, marginBottom: 12 }}>♠️</div>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 6, letterSpacing: -0.5 }}>
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
            width: '100%', padding: '12px 16px', fontSize: 16, borderRadius: 10,
            border: error ? '1.5px solid #E24B4A' : '1px solid #ddd',
            outline: 'none', marginBottom: 12, background: '#fafafa',
            textAlign: 'center', letterSpacing: '0.2em',
          }}
        />

        {error && (
          <p style={{ color: '#A32D2D', fontSize: 13, marginBottom: 12 }}>
            Wrong passcode — try again
          </p>
        )}

        <button
          onClick={submit}
          style={{
            width: '100%', padding: '13px', background: '#1D9E75', color: '#fff',
            border: 'none', borderRadius: 10, fontSize: 16, fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Enter →
        </button>
      </div>
    </div>
  )
}
