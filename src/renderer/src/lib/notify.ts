import { createContext, useContext } from 'react'

/** 全局 toast：App 提供，2.2s 自动消失 */
export const NotifyContext = createContext<(msg: string) => void>(() => {})

export function useNotify(): (msg: string) => void {
  return useContext(NotifyContext)
}
