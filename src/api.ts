export function apiBase() {
  const buildBase = import.meta.env.BASE_URL.replace(/\/$/, '')
  if (buildBase) return `${buildBase}/api`

  return window.location.pathname.startsWith('/speak') ? '/speak/api' : '/api'
}

export function apiUrl(path: string) {
  return `${apiBase()}${path}`
}

export function makeHumanAudioSocketUrl(
  callControlId: string,
  playgroundSupervisionToken = '',
) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${protocol}//${window.location.host}${apiBase()}/calls/${encodeURIComponent(
    callControlId,
  )}/human-audio`
  return playgroundSupervisionToken
    ? `${url}?token=${encodeURIComponent(playgroundSupervisionToken)}`
    : url
}

export function makePlaygroundSupervisionSocketUrl(
  callControlId: string,
  playgroundSupervisionToken: string,
) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${protocol}//${window.location.host}${apiBase()}/calls/${encodeURIComponent(
    callControlId,
  )}/supervision`
  return `${url}?token=${encodeURIComponent(playgroundSupervisionToken)}`
}

export function makeConfigTestAudioSocketUrl(testId: string) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${apiBase()}/config-tests/${encodeURIComponent(
    testId,
  )}/audio`
}
