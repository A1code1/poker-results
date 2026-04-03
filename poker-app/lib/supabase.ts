import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

export type GameRecord = {
  id: string
  created_at: string
  game_date: string | null
  date_source: string | null
  summary: Record<string, unknown>
  results: Record<string, unknown>[]
  settlements: Record<string, unknown>[]
  players: Record<string, unknown>[]
  host_id: string | null
}
