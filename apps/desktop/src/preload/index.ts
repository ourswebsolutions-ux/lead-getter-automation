import { contextBridge, ipcRenderer } from 'electron'

const CHANNEL = /^[a-z0-9]+:[A-Za-z0-9]+$/

const api = {
  invoke: async (channel: string, ...args: unknown[]) => {
    if (!CHANNEL.test(channel)) throw new Error('Invalid channel')
    const res = await ipcRenderer.invoke(channel, ...args)
    if (!res?.ok) throw new Error(res?.error ?? 'Unknown error')
    return res.data
  },
  onEvent: (cb: (evt: { type: string; payload: any }) => void) => {
    const listener = (_: unknown, evt: { type: string; payload: any }) => cb(evt)
    ipcRenderer.on('app:event', listener)
    return () => ipcRenderer.removeListener('app:event', listener)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('lge', api)
export type LgeApi = typeof api
