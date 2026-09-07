import 'dotenv/config'
import {
  repairWorkspaceEmailMailboxThreadIdentity,
} from '../server/workspace-store.mjs'
import {
  cleanEmail,
  getWorkspaceEmailAccount,
} from '../server/runtime-config.mjs'

const apply = process.argv.includes('--apply')
const mailboxEmail = cleanEmail(
  argValue('--account') ||
    argValue('--mailbox') ||
    process.env.WORKSPACE_EMAIL_THREAD_REPAIR_ACCOUNT ||
    getWorkspaceEmailAccount(),
)

const result = await repairWorkspaceEmailMailboxThreadIdentity({
  apply,
  mailboxEmail,
})

const response = {
  ...result,
  note: apply
    ? 'Applied only the listed unresolved Workspace-mailbox email thread identity repairs.'
    : 'Dry-run only. Re-run with --apply after reviewing repairs.',
}

console.log(JSON.stringify(response, null, 2))
if (!response.ok) process.exitCode = 1

function argValue(name) {
  const prefix = `${name}=`
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length)
}
