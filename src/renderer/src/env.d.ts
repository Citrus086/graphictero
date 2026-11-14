import type { GraphicteroApi } from '../../shared/ipc'

declare global {
  interface Window {
    graphictero: GraphicteroApi
  }
}

export {}
