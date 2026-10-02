// Delivers terminal output from the main process to the xterm instance that owns it.

type DataFn = (data: string) => void
type ExitFn = (code: number) => void

const dataListeners = new Map<string, DataFn>()
const exitListeners = new Map<string, ExitFn>()
const buffered = new Map<string, string[]>()

export const terminalBus = {
  data(id: string, data: string): void {
    const fn = dataListeners.get(id)
    if (fn) fn(data)
    else buffered.set(id, [...(buffered.get(id) ?? []), data])
  },
  exit(id: string, code: number): void {
    exitListeners.get(id)?.(code)
  },
  listen(id: string, onData: DataFn, onExit: ExitFn): () => void {
    dataListeners.set(id, onData)
    exitListeners.set(id, onExit)
    for (const chunk of buffered.get(id) ?? []) onData(chunk)
    buffered.delete(id)
    return () => {
      dataListeners.delete(id)
      exitListeners.delete(id)
    }
  }
}
