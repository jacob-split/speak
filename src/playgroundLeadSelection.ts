import { getBrowserStorage } from './browserStorage'

const playgroundPhoneLeadStorageKey =
  'speak:playground-phone-test-lead-id:v1'
const playgroundPhoneSmartViewStorageKey =
  'speak:playground-phone-test-smart-view-id:v1'

export function readPlaygroundPhoneLeadId() {
  try {
    const storage = getBrowserStorage()
    return storage?.getItem(playgroundPhoneLeadStorageKey) || ''
  } catch {
    return ''
  }
}

export function writePlaygroundPhoneLeadId(leadId: string) {
  try {
    const storage = getBrowserStorage()
    if (!storage) return
    if (leadId) {
      storage.setItem(playgroundPhoneLeadStorageKey, leadId)
    } else {
      storage.removeItem(playgroundPhoneLeadStorageKey)
    }
  } catch {
    // This preference should not block Library or Playground in restricted storage contexts.
  }
}

export function readPlaygroundPhoneSmartViewId() {
  try {
    const storage = getBrowserStorage()
    return storage?.getItem(playgroundPhoneSmartViewStorageKey) || ''
  } catch {
    return ''
  }
}

export function writePlaygroundPhoneSmartViewId(smartViewId: string) {
  try {
    const storage = getBrowserStorage()
    if (!storage) return
    if (smartViewId) {
      storage.setItem(playgroundPhoneSmartViewStorageKey, smartViewId)
    } else {
      storage.removeItem(playgroundPhoneSmartViewStorageKey)
    }
  } catch {
    // This preference should not block Library or Playground in restricted storage contexts.
  }
}
