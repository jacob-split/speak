export function withCallToolsRuntimeIdentity(profile = {}) {
  const config = profile?.config && typeof profile.config === 'object'
    ? profile.config
    : {}
  return {
    ...config,
    agentProfileId: profile.id,
    agentProfileName: profile.name,
    dialerProvider: 'calltools',
  }
}
