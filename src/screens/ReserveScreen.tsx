import { useState } from 'react'
import { motion } from 'framer-motion'
import { Scissors, Clock, CalendarDays, Check, ChevronRight } from 'lucide-react'
import { getStoredValue, setStoredValue, RESERVE_MENU_KEY, RESERVE_TIME_KEY } from '../utils/storage'

interface MenuItem {
  id: string
  name: string
  price: string
  duration: string
}

const MENUS: MenuItem[] = [
  { id: 'cut', name: 'カット', price: '¥3,300', duration: '約40分' },
  { id: 'cut-shave', name: 'カット＋シェービング', price: '¥5,500', duration: '約60分' },
  { id: 'cut-color', name: 'カット＋カラー', price: '¥8,800', duration: '約90分' },
]

interface TimeSlot {
  id: string
  label: string
  hours: string
}

const TIME_SLOTS: TimeSlot[] = [
  { id: 'morning', label: '午前', hours: '10:00-12:00' },
  { id: 'noon', label: '昼', hours: '12:00-15:00' },
  { id: 'evening', label: '夕方', hours: '15:00-19:00' },
]

export function ReserveScreen() {
  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(
    getStoredValue<string>(RESERVE_MENU_KEY, '') || null
  )
  const [selectedTimeSlot, setSelectedTimeSlot] = useState<string | null>(
    getStoredValue<string>(RESERVE_TIME_KEY, '') || null
  )
  const [confirmed, setConfirmed] = useState(false)

  function handleMenuSelect(id: string) {
    setSelectedMenuId(id)
    setStoredValue(RESERVE_MENU_KEY, id)
    setConfirmed(false)
  }

  function handleTimeSelect(id: string) {
    setSelectedTimeSlot(id)
    setStoredValue(RESERVE_TIME_KEY, id)
    setConfirmed(false)
  }

  function handleConfirm() {
    if (!selectedMenuId || !selectedTimeSlot) return
    setConfirmed(true)
  }

  const selectedMenu = MENUS.find((m) => m.id === selectedMenuId) ?? null
  const selectedTime = TIME_SLOTS.find((t) => t.id === selectedTimeSlot) ?? null
  const canConfirm = selectedMenuId !== null && selectedTimeSlot !== null

  return (
    <div className="py-5 space-y-6">
      {/* Section header */}
      <div className="px-5">
        <p className="text-[10px] tracking-[0.2em] uppercase" style={{ color: 'rgba(201,162,39,0.45)' }}>
          Reservation
        </p>
        <p className="text-xl font-bold tracking-wide mt-0.5" style={{ color: '#F5F0E8' }}>
          ご予約
        </p>
        <p className="text-sm mt-0.5" style={{ color: '#8A8A7A' }}>
          男前の時間を、先に押さえる。
        </p>
      </div>

      {/* CTA card */}
      <div className="mx-4">
        <div
          className="rounded-2xl overflow-hidden"
          style={{
            background: 'linear-gradient(135deg, #1C1C1A 0%, #0E0E0C 60%, #130E02 100%)',
            border: '1px solid rgba(201,162,39,0.28)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.7)',
          }}
        >
          <div
            className="h-1 w-full"
            style={{ background: 'linear-gradient(90deg, #8B1A2A, #C9A227, #8B1A2A)' }}
          />
          <div className="px-5 py-4 flex items-center gap-4">
            <div
              className="flex-shrink-0 p-3 rounded-xl"
              style={{
                background: 'rgba(201,162,39,0.07)',
                border: '1px solid rgba(201,162,39,0.15)',
              }}
            >
              <CalendarDays size={24} strokeWidth={1.5} style={{ color: 'rgba(201,162,39,0.65)' }} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold" style={{ color: '#F5F0E8' }}>
                今すぐ予約する
              </p>
              <p className="text-[11px] mt-0.5" style={{ color: '#8A8A7A' }}>
                外部予約サービス連携予定
              </p>
            </div>
            <button
              type="button"
              className="flex-shrink-0 px-4 py-2 rounded-lg text-xs font-semibold tracking-wider transition-opacity active:opacity-60"
              style={{
                background: 'rgba(201,162,39,0.1)',
                border: '1px solid rgba(201,162,39,0.25)',
                color: 'rgba(201,162,39,0.8)',
              }}
            >
              予約へ
            </button>
          </div>
        </div>
      </div>

      {/* Menu selection */}
      <div className="px-4">
        <p
          className="text-[10px] tracking-[0.2em] uppercase mb-3"
          style={{ color: 'rgba(201,162,39,0.45)' }}
        >
          メニューを選ぶ
        </p>
        <div className="space-y-2">
          {MENUS.map((menu) => {
            const isSelected = selectedMenuId === menu.id
            return (
              <motion.button
                key={menu.id}
                type="button"
                onClick={() => handleMenuSelect(menu.id)}
                whileTap={{ scale: 0.98 }}
                className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl text-left"
                style={{
                  background: isSelected ? 'rgba(201,162,39,0.06)' : '#1A1A1A',
                  border: isSelected
                    ? '1.5px solid rgba(201,162,39,0.45)'
                    : '1px solid rgba(255,255,255,0.05)',
                  boxShadow: isSelected ? '0 0 16px rgba(201,162,39,0.08)' : 'none',
                }}
              >
                <div
                  className="flex-shrink-0 p-2 rounded-lg"
                  style={{
                    background: isSelected
                      ? 'rgba(201,162,39,0.1)'
                      : 'rgba(255,255,255,0.03)',
                  }}
                >
                  <Scissors
                    size={16}
                    strokeWidth={1.8}
                    style={{
                      color: isSelected ? '#C9A227' : 'rgba(245,240,232,0.25)',
                      transform: 'rotate(270deg)',
                    }}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p
                    className="text-sm font-semibold"
                    style={{ color: isSelected ? '#F5F0E8' : 'rgba(245,240,232,0.6)' }}
                  >
                    {menu.name}
                  </p>
                  <p className="text-[11px] mt-0.5" style={{ color: '#8A8A7A' }}>
                    {menu.duration}
                  </p>
                </div>
                <span
                  className="flex-shrink-0 text-sm font-bold"
                  style={{ color: isSelected ? '#C9A227' : 'rgba(201,162,39,0.35)' }}
                >
                  {menu.price}
                </span>
                {isSelected ? (
                  <div
                    className="flex-shrink-0 flex items-center justify-center rounded-full"
                    style={{ width: 20, height: 20, background: 'rgba(201,162,39,0.85)' }}
                  >
                    <Check size={12} strokeWidth={2.5} style={{ color: '#0D0D0D' }} />
                  </div>
                ) : (
                  <ChevronRight size={15} strokeWidth={1.8} style={{ color: 'rgba(255,255,255,0.15)' }} />
                )}
              </motion.button>
            )
          })}
        </div>
      </div>

      {/* Time slot selection */}
      <div className="px-4">
        <p
          className="text-[10px] tracking-[0.2em] uppercase mb-3"
          style={{ color: 'rgba(201,162,39,0.45)' }}
        >
          希望時間帯
        </p>
        <div className="grid grid-cols-3 gap-2">
          {TIME_SLOTS.map((slot) => {
            const isSelected = selectedTimeSlot === slot.id
            return (
              <motion.button
                key={slot.id}
                type="button"
                onClick={() => handleTimeSelect(slot.id)}
                whileTap={{ scale: 0.96 }}
                className="flex flex-col items-center gap-1.5 py-3.5 rounded-xl"
                style={{
                  background: isSelected ? 'rgba(201,162,39,0.07)' : '#1A1A1A',
                  border: isSelected
                    ? '1.5px solid rgba(201,162,39,0.5)'
                    : '1px solid rgba(255,255,255,0.05)',
                }}
              >
                <Clock
                  size={16}
                  strokeWidth={1.8}
                  style={{ color: isSelected ? '#C9A227' : 'rgba(245,240,232,0.22)' }}
                />
                <span
                  className="text-sm font-semibold"
                  style={{ color: isSelected ? '#F5F0E8' : 'rgba(245,240,232,0.5)' }}
                >
                  {slot.label}
                </span>
                <span className="text-[9px]" style={{ color: '#8A8A7A' }}>
                  {slot.hours}
                </span>
              </motion.button>
            )
          })}
        </div>
      </div>

      {/* CTA / Confirmation */}
      <div className="px-4">
        {confirmed && selectedMenu && selectedTime ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
            className="space-y-3"
          >
            <div
              className="rounded-xl px-4 py-4 space-y-3"
              style={{
                background: 'rgba(139,26,42,0.1)',
                border: '1px solid rgba(139,26,42,0.3)',
              }}
            >
              <p
                className="text-[10px] tracking-[0.18em] uppercase"
                style={{ color: 'rgba(176,32,53,0.7)' }}
              >
                予約内容の確認
              </p>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px]" style={{ color: '#8A8A7A' }}>メニュー</span>
                  <span className="text-sm font-semibold" style={{ color: '#F5F0E8' }}>
                    {selectedMenu.name}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px]" style={{ color: '#8A8A7A' }}>料金</span>
                  <span className="text-sm font-bold" style={{ color: '#C9A227' }}>
                    {selectedMenu.price}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px]" style={{ color: '#8A8A7A' }}>希望時間帯</span>
                  <span className="text-sm font-semibold" style={{ color: '#F5F0E8' }}>
                    {selectedTime.label}（{selectedTime.hours}）
                  </span>
                </div>
              </div>
              <div
                className="pt-2"
                style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
              >
                <p className="text-[11px]" style={{ color: 'rgba(176,32,53,0.75)' }}>
                  スタッフに相談して確定します
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setConfirmed(false)}
              className="w-full py-2.5 rounded-xl text-xs font-medium tracking-wider transition-opacity active:opacity-60"
              style={{
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'rgba(245,240,232,0.35)',
              }}
            >
              変更する
            </button>
          </motion.div>
        ) : (
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="w-full py-3.5 rounded-xl font-semibold tracking-widest text-sm transition-opacity active:opacity-70 disabled:cursor-not-allowed"
            style={{
              background: canConfirm
                ? 'linear-gradient(135deg, #8B1A2A 0%, #B02035 100%)'
                : 'rgba(74,74,74,0.2)',
              color: canConfirm ? '#F5F0E8' : '#4A4A4A',
              border: canConfirm
                ? '1px solid rgba(176,32,53,0.45)'
                : '1px solid rgba(74,74,74,0.2)',
            }}
          >
            この内容で相談する
          </button>
        )}
      </div>

      <div className="h-2" />
    </div>
  )
}
