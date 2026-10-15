/** Explicit development-only presentation mode. Never authenticates with a backend. */
export function isHqPreview(): boolean {
  return import.meta.env.DEV && window.location.pathname.startsWith('/headquarters') && new URLSearchParams(window.location.search).get('preview') === '1'
}
