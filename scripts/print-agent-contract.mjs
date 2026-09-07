import 'dotenv/config'
import { buildSpeakAgentContract } from '../server/agent-contract.mjs'

const contract = buildSpeakAgentContract({
  basePath: process.env.BASE_PATH || '',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
})

process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`)
