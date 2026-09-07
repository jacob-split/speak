import 'dotenv/config'
import {
  repairDefaultOffInboundCallMessages,
} from '../server/workspace-store.mjs'

const apply = process.argv.includes('--apply')

const result = await repairDefaultOffInboundCallMessages({ apply })

const response = {
  ...result,
  note: apply
    ? 'Applied only default-off inbound call source records that still used received-call text.'
    : 'Dry-run only. Re-run with --apply after reviewing default-off inbound call source records.',
}

console.log(JSON.stringify(response, null, 2))
if (!response.ok) process.exitCode = 1
