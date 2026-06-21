export type AppEnv = 'production' | 'staging'

export function getAppEnv(): AppEnv {
  return import.meta.env.VITE_APP_ENV === 'staging' ? 'staging' : 'production'
}

export function isStaging(): boolean {
  return getAppEnv() === 'staging'
}
