import { useLayoutEffect, type RefObject } from 'react'

/**
 * When the element leaves the page while it has keyboard focus (a button that goes away once
 * its work is done), focuses the first of `next` inside the nearest `scope` instead of
 * dropping focus to the page. The component that owns `ref` must unmount with the element.
 */
export function useFocusHandoff(ref: RefObject<HTMLElement | null>, scope: string, next: string[]): void {
  useLayoutEffect(() => {
    const el = ref.current
    // Layout cleanups run before React removes the element, so it still has focus here.
    return () => {
      if (!el || document.activeElement !== el) return
      const area = el.closest(scope)
      queueMicrotask(() => {
        for (const selector of next) {
          const target = area?.querySelector<HTMLElement>(selector)
          if (target?.isConnected) return target.focus({ preventScroll: true })
        }
      })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}
