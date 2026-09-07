import 'dotenv/config'
import { buildSpeakOpenApiDocument } from '../server/agent-contract.mjs'

const document = buildSpeakOpenApiDocument({
  basePath: process.env.BASE_PATH || '',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
})

process.stdout.write(`${JSON.stringify(document, null, 2)}\n`)
