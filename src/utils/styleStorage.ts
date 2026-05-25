/**
 * StyleCard repository — localStorage implementation.
 *
 * Migration guide (Firebase / Supabase):
 *   1. Replace `loadStyles`   → collection.get() / .select()
 *   2. Replace `createStyle`  → collection.add() / .insert()
 *   3. Replace `updateStyle`  → doc.update() / .update()
 *   4. Replace `deleteStyle`  → doc.delete() / .delete()
 *   5. Replace `moveStyle`    → batch update of sortOrder field
 *   All function signatures remain identical — callers need no changes.
 */

import type { StyleCard, StyleCardDraft } from '../data/styleCard'
import { getStoredValue, setStoredValue } from './storage'

export const STYLES_STORAGE_KEY = 'ginjiro_cms_styles'

/* ── Internal helpers ──────────────────────────────────────────── */

function generateId(): string {
  return `style-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function now(): string {
  return new Date().toISOString()
}

function readAll(): StyleCard[] {
  return getStoredValue<StyleCard[]>(STYLES_STORAGE_KEY, [])
}

function writeAll(styles: StyleCard[]): void {
  setStoredValue(STYLES_STORAGE_KEY, styles)
}

/* ── Public API ────────────────────────────────────────────────── */

/** Load all styles sorted by sortOrder ascending. */
export function loadStyles(): StyleCard[] {
  return [...readAll()].sort((a, b) => a.sortOrder - b.sortOrder)
}

/** Create a new style and persist it. Returns the created record. */
export function createStyle(draft: StyleCardDraft): StyleCard {
  const existing = readAll()
  const maxOrder =
    existing.length > 0 ? Math.max(...existing.map((s) => s.sortOrder)) : -1
  const style: StyleCard = {
    ...draft,
    id: generateId(),
    sortOrder: draft.sortOrder > maxOrder ? draft.sortOrder : maxOrder + 1,
    createdAt: now(),
    updatedAt: now(),
  }
  writeAll([...existing, style])
  return style
}

/** Overwrite specific fields of an existing style. Returns updated record or null. */
export function updateStyle(
  id: string,
  patch: Partial<Omit<StyleCard, 'id' | 'createdAt'>>,
): StyleCard | null {
  const all = readAll()
  const idx = all.findIndex((s) => s.id === id)
  if (idx === -1) return null
  const updated: StyleCard = { ...all[idx], ...patch, updatedAt: now() }
  all[idx] = updated
  writeAll(all)
  return updated
}

/** Delete a style by id. */
export function deleteStyle(id: string): void {
  writeAll(readAll().filter((s) => s.id !== id))
}

/** Move a style one step up or down in sortOrder. */
export function moveStyle(id: string, direction: 'up' | 'down'): void {
  const sorted = loadStyles()
  const idx = sorted.findIndex((s) => s.id === id)
  if (idx === -1) return
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1
  if (swapIdx < 0 || swapIdx >= sorted.length) return
  const tempOrder = sorted[idx].sortOrder
  sorted[idx] = { ...sorted[idx], sortOrder: sorted[swapIdx].sortOrder }
  sorted[swapIdx] = { ...sorted[swapIdx], sortOrder: tempOrder }
  writeAll(sorted)
}

/** Computed stats for the dashboard. */
export function loadStyleStats() {
  const all = loadStyles()
  return {
    total: all.length,
    published: all.filter((s) => s.isPublished).length,
    unpublished: all.filter((s) => !s.isPublished).length,
    featured: all.filter((s) => s.isFeatured).length,
  }
}
