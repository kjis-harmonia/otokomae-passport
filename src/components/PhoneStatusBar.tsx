import { useState, useEffect } from 'react'
import { Wifi, Battery } from 'lucide-react'
import { getCurrentTime } from '../utils/date'

export function PhoneStatusBar() {
  const [time, setTime] = useState(getCurrentTime)

  useEffect(() => {
    const timer = setInterval(() => setTime(getCurrentTime()), 10000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div
      className="flex items-center justify-between px-5 py-1.5 select-none"
      style={{ background: '#0D0D0D', color: 'rgba(245,240,232,0.5)' }}
    >
      <span className="text-xs font-semibold tracking-wider">{time}</span>
      <div className="flex items-center gap-2">
        <Wifi size={12} strokeWidth={2} />
        <Battery size={14} strokeWidth={2} />
      </div>
    </div>
  )
}
