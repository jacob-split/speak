import 'dotenv/config'
import { buildSpeakAgentReadinessReport } from '../server/agent-contract.mjs'

const report = buildSpeakAgentReadinessReport({
  basePath: process.env.BASE_PATH || '',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
})

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
