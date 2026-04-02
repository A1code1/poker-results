'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(false)
  const router = useRouter()

  useEffect(() => {
    if (sessionStorage.getItem('poker-auth') === 'true') {
      setAuthed(true)
    } else {
      router.replace('/')
    }
  }, [router])

  if (!authed) return null
  return <>{children}</>
}
