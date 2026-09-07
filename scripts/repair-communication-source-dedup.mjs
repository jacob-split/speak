import 'dotenv/config'
import {
  repairDuplicateCommunicationSourceMessages,
} from '../server/workspace-store.mjs'

const apply = process.argv.includes('--apply')

const result = await repairDuplicateCommunicationSourceMessages({ apply })

const response = {
  ...result,
  note: apply
    ? 'Applied only duplicate communication messages with the same native provider source event.'
    : 'Dry-run only. Re-run with --apply after reviewing duplicate provider-source messages.',
}

console.log(JSON.stringify(response, null, 2))
if (!response.ok) process.exitCode = 1
