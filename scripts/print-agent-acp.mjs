import 'dotenv/config'
import { buildSpeakAcpManifest } from '../server/agent-contract.mjs'

const manifest = buildSpeakAcpManifest({
  basePath: process.env.BASE_PATH || '',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
})

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
