'use client'

import { useState } from 'react'

interface Props {
  name?: string | null
  email?: string | null
  photoUrl?: string | null
  size?: number
  className?: string
}

/** Google profile photo with an initials fallback (also used if the photo fails to load). */
export function UserAvatar({ name, email, photoUrl, size = 32, className = '' }: Readonly<Props>) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const initial = ((name || email || '?').trim()[0] ?? '?').toUpperCase()
  const showPhoto = Boolean(photoUrl) && failedUrl !== photoUrl
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.42)) }
  if (showPhoto) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- static export, Google-hosted avatar
      <img
        src={photoUrl!}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(photoUrl!)}
        style={style}
        className={`shrink-0 rounded-full object-cover ${className}`}
      />
    )
  }
  return (
    <span aria-hidden="true" style={style} className={`flex shrink-0 items-center justify-center rounded-full bg-[#eaf2fd] font-semibold text-[#0058b0] ${className}`}>
      {initial}
    </span>
  )
}
