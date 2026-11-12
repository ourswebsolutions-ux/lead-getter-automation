declare global {
  interface Window {
    lge: {
      invoke: <T = any>(channel: string, ...args: unknown[]) => Promise<T>
      onEvent: (cb: (evt: { type: string; payload: any }) => void) => () => void
      platform: string
    }
  }
}
export {}
