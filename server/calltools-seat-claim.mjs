export async function assertCallToolsSeatClaimSafe({
  gatewayStatus = {},
  readNativeStatus,
} = {}) {
  if (gatewayStatus?.connected === true && gatewayStatus?.gateway?.sipRegistered === true) {
    return {
      nativeAgentReady: null,
      ownershipProven: true,
      reason: 'matching_speak_gateway_healthy',
    }
  }

  if (typeof readNativeStatus !== 'function') {
    throw new TypeError('readNativeStatus must be a function')
  }

  let nativeStatus
  try {
    nativeStatus = await readNativeStatus()
  } catch {
    throw seatClaimError(
      503,
      'CallTools agent status could not be read, so Speak did not claim the shared phone.',
      'calltools_native_seat_state_unproven',
    )
  }

  if (
    nativeStatus?.humanSeatActive === true ||
    nativeStatus?.agentReady === true ||
    nativeStatus?.campaignAgentReady === true ||
    Number(nativeStatus?.agentLiveCallsCount || 0) > 0 ||
    Number(nativeStatus?.liveCallsCount || 0) > 0
  ) {
    throw seatClaimError(
      409,
      'The shared CallTools seat is Available or handling a live call without a matching Speak gateway owner.',
      'calltools_human_seat_active',
    )
  }

  if (nativeStatus?.seatClaimSafe !== true) {
    throw seatClaimError(
      503,
      'CallTools Unavailable and zero-live-call state are not proven, so Speak did not claim the shared phone.',
      'calltools_native_seat_state_unproven',
    )
  }

  return {
    nativeAgentReady: false,
    ownershipProven: false,
    reason:
      nativeStatus?.agentLoggedIn === true
        ? 'native_agent_confirmed_unavailable_without_live_calls'
        : 'native_agent_confirmed_logged_out_without_live_calls',
  }
}

function seatClaimError(status, message, code) {
  return Object.assign(new Error(message), { status, code })
}
