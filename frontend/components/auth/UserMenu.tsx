'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, History, LayoutDashboard, LogOut, UserRound } from 'lucide-react'
import { useAuth } from '@/lib/auth/AuthProvider'
import { UserAvatar } from './UserAvatar'

interface Props {
  onSignIn: () => void
  onNavigate: (view: 'patient' | 'profile' | 'history') => void
}

/** Navbar account control: "Sign in" when signed out, avatar + dropdown when signed in. */
export function UserMenu({ onSignIn, onNavigate }: Readonly<Props>) {
  const { status, profile, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (status === 'loading') return <span className="h-8 w-8 animate-pulse rounded-full bg-[#e8e8ed]" aria-label="Checking sign-in" role="status" />

  if (status !== 'signed-in' || !profile) {
    return (
      <button type="button" onClick={onSignIn} className="inline-flex h-8 shrink-0 items-center rounded-full px-3 text-[13px] font-medium text-[#1d1d1f]/80 transition-colors hover:text-[#1d1d1f] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/30">
        Sign in
      </button>
    )
  }

  const go = (v: 'patient' | 'profile' | 'history') => {
    setOpen(false)
    onNavigate(v)
  }
  const item = 'flex w-full min-h-11 items-center gap-2.5 rounded-xl px-3 text-left text-sm text-[#1d1d1f] transition hover:bg-[#f5f5f7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3]/40'

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${profile.full_name || profile.email}`}
        className="flex items-center gap-1 rounded-full p-0.5 pr-1.5 transition hover:bg-black/[0.05] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/30"
      >
        <UserAvatar name={profile.full_name} email={profile.email} photoUrl={profile.photo_url} size={28} />
        <ChevronDown size={14} className={`hidden text-[#6e6e73] transition-transform sm:block ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+8px)] z-[60] w-[min(18rem,calc(100vw-2rem))] rounded-2xl border border-[#d2d2d7] bg-white p-2 shadow-[0_16px_50px_rgba(0,0,0,.14)]">
          <div className="flex items-center gap-3 px-3 py-3">
            <UserAvatar name={profile.full_name} email={profile.email} photoUrl={profile.photo_url} size={40} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[#1d1d1f]">{profile.full_name || 'Your account'}</p>
              <p className="truncate text-xs text-[#6e6e73]">{profile.email}</p>
            </div>
          </div>
          <div className="my-1 h-px bg-[#f0f0f3]" />
          <button role="menuitem" type="button" className={item} onClick={() => go('profile')}><UserRound size={16} className="text-[#6e6e73]" aria-hidden="true" />My profile</button>
          <button role="menuitem" type="button" className={item} onClick={() => go('patient')}><LayoutDashboard size={16} className="text-[#6e6e73]" aria-hidden="true" />My care</button>
          <button role="menuitem" type="button" className={item} onClick={() => go('history')}><History size={16} className="text-[#6e6e73]" aria-hidden="true" />Consultation history</button>
          <div className="my-1 h-px bg-[#f0f0f3]" />
          <button role="menuitem" type="button" className={`${item} text-[#b3261e]`} onClick={() => { setOpen(false); void signOut() }}><LogOut size={16} aria-hidden="true" />Sign out</button>
        </div>
      )}
    </div>
  )
}
