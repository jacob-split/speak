export type DialerAgentDuty = {
  leaseId?: string
  profileId?: string
  status?: 'arming' | 'attention' | 'disarming' | 'off' | 'on'
}

const activeCallToolsDutyStatuses = new Set([
  'arming',
  'attention',
  'disarming',
  'on',
])

export function callToolsDutyIsActive(duty?: DialerAgentDuty) {
  return Boolean(
    duty?.leaseId && activeCallToolsDutyStatuses.has(duty.status || ''),
  )
}

export function resolveDialerAgentProfileId(
  duty: DialerAgentDuty | undefined,
  savedProfileId: string,
) {
  if (callToolsDutyIsActive(duty) && duty?.profileId) {
    return duty.profileId
  }
  return savedProfileId
}
