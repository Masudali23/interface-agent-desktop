// The only bridge between the UI and the rest of the computer.
// The UI can call these functions and nothing else.

import { contextBridge, ipcRenderer } from 'electron'
import { API_METHODS, type Bridge, type IfaceApi } from '@shared/api'
import type { AppEvent } from '@shared/types'

const api = Object.fromEntries(
  API_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke('api', m, ...args)])
) as unknown as IfaceApi

const bridge: Bridge = {
  ...api,
  onEvent: (cb) => {
    const listener = (_: unknown, e: AppEvent): void => cb(e)
    ipcRenderer.on('event', listener)
    return () => ipcRenderer.removeListener('event', listener)
  }
}

contextBridge.exposeInMainWorld('iface', bridge)
