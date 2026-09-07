export const speakRouteChangeEvent = 'speak:route-change'
type SpeakViewTransitionName = 'route' | 'library-mode'
type SpeakViewTransitionTarget = 'library' | 'dialer' | 'configs' | 'root'

type ViewTransitionController = {
  finished?: Promise<void>
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => ViewTransitionController
}

export function currentAppPathname() {
  return window.location.pathname.replace(/\/+$/, '')
}

export function listenToAppNavigation(listener: () => void) {
  window.addEventListener('popstate', listener)
  window.addEventListener(speakRouteChangeEvent, listener)

  return () => {
    window.removeEventListener('popstate', listener)
    window.removeEventListener(speakRouteChangeEvent, listener)
  }
}

export function withSpeakViewTransition(
  update: () => void,
  transitionName: SpeakViewTransitionName = 'route',
  transitionTarget?: SpeakViewTransitionTarget,
) {
  const transitionDocument = document as ViewTransitionDocument
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (!transitionDocument.startViewTransition || prefersReducedMotion) {
    update()
    return
  }

  document.documentElement.dataset.speakViewTransition = transitionName
  if (transitionTarget) {
    document.documentElement.dataset.speakViewTransitionTarget = transitionTarget
  }
  const transition = transitionDocument.startViewTransition(update)
  void transition.finished?.finally(() => {
    if (document.documentElement.dataset.speakViewTransition === transitionName) {
      delete document.documentElement.dataset.speakViewTransition
    }
    if (transitionTarget && document.documentElement.dataset.speakViewTransitionTarget === transitionTarget) {
      delete document.documentElement.dataset.speakViewTransitionTarget
    }
  })
}

function appRouteTarget(pathname: string): SpeakViewTransitionTarget {
  if (pathname.endsWith('/library')) return 'library'
  if (pathname.endsWith('/configs')) return 'configs'
  if (pathname.endsWith('/dialer')) return 'dialer'
  return 'root'
}

export function navigateToAppUrl(href: string) {
  const nextUrl = new URL(href, window.location.href)
  if (nextUrl.origin !== window.location.origin) return false

  const oldUrl = window.location.href
  const oldPathname = new URL(oldUrl).pathname.replace(/\/+$/, '')
  const nextPathname = nextUrl.pathname.replace(/\/+$/, '')

  function updateRoute() {
    if (nextUrl.href !== oldUrl) {
      window.history.pushState(null, '', nextUrl)
    }
    window.dispatchEvent(new Event(speakRouteChangeEvent))

    if (new URL(oldUrl).hash !== nextUrl.hash) {
      window.dispatchEvent(
        new HashChangeEvent('hashchange', {
          oldURL: oldUrl,
          newURL: nextUrl.href,
        }),
      )
    }
  }

  if (oldPathname !== nextPathname) {
    withSpeakViewTransition(updateRoute, 'route', appRouteTarget(nextPathname))
  } else {
    updateRoute()
  }

  return true
}
