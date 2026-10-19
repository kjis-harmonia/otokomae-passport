// GINPay Stripe webhook.
//
// Required Supabase Edge Function secrets:
//   STRIPE_WEBHOOK_SECRET
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// The browser must never credit GINPay directly. This function verifies Stripe's
// webhook signature first, then calls the database RPC that creates the immutable
// GINPay charge transaction idempotently.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TOLERANCE_SECONDS = 300
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null
  const out = new Uint8Array(value.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return out
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const aa = hexToBytes(a)
  const bb = hexToBytes(b)
  if (!aa || !bb || aa.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i] ^ bb[i]
  return diff === 0
}

function parseStripeSignature(header: string): { timestamp: string; signatures: string[] } {
  const parts = header.split(',').map((part) => part.trim())
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2) ?? ''
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3))
  return { timestamp, signatures }
}

async function verifyStripeSignature(payload: string, header: string, secret: string): Promise<boolean> {
  const { timestamp, signatures } = parseStripeSignature(header)
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || signatures.length === 0) return false
  if (Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`))
  const expected = hex(digest)
  return signatures.some((sig) => timingSafeEqualHex(sig, expected))
}

function metadataClientId(object: Record<string, unknown>): string | null {
  const metadata = object.metadata
  if (!metadata || typeof metadata !== 'object') return null
  // GINPay のチャージとして作った決済だけを対象にする（汎用の client_id は他用途の決済と混ざるので見ない）
  const value = (metadata as Record<string, unknown>).ginpay_client_id
  return typeof value === 'string' && UUID_RE.test(value) ? value : null
}

function stripeObject(event: Record<string, unknown>): Record<string, unknown> {
  const data = event.data
  if (!data || typeof data !== 'object') return {}
  const object = (data as Record<string, unknown>).object
  return object && typeof object === 'object' ? object as Record<string, unknown> : {}
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function asAmount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const stripeSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!stripeSecret || !supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: 'not_configured' }), { status: 500 })
  }

  const signature = req.headers.get('stripe-signature') ?? ''
  const payload = await req.text()
  const valid = await verifyStripeSignature(payload, signature, stripeSecret)
  if (!valid) return new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 400 })

  let event: Record<string, unknown>
  try {
    event = JSON.parse(payload) as Record<string, unknown>
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_payload' }), { status: 400 })
  }

  const object = stripeObject(event)
  const type = asText(event.type) ?? 'unknown'
  const objectId = asText(object.id)
  const paymentIntentId =
    type.startsWith('payment_intent.')
      ? objectId
      : asText(object.payment_intent) ?? asText(object.payment_intent_id)
  const checkoutSessionId = type.startsWith('checkout.session.') ? objectId : asText(object.checkout_session_id)
  const chargeId = asText(object.latest_charge) ?? asText(object.charge) ?? asText(object.charge_id)
  const amount =
    type === 'payment_intent.succeeded'
      ? asAmount(object.amount_received) ?? asAmount(object.amount)
      : asAmount(object.amount_total) ?? asAmount(object.amount_received) ?? asAmount(object.amount)

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await supabase.rpc('ginpay_apply_stripe_webhook', {
    p_event_id: asText(event.id),
    p_event_type: type,
    p_client_id: metadataClientId(object),
    p_amount: amount,
    p_payment_intent_id: paymentIntentId,
    p_checkout_session_id: checkoutSessionId,
    p_charge_id: chargeId,
    p_payload: event,
  })

  if (error) {
    return new Response(JSON.stringify({ error: 'database_error' }), { status: 500 })
  }
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
})
