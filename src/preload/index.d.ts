import type { Bridge } from '@shared/api'

declare global {
  interface Window {
    iface: Bridge
  }
}

export {}
