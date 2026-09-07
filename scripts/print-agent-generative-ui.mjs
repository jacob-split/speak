import 'dotenv/config'
import { buildSpeakGenerativeUiManifest } from '../server/agent-contract.mjs'

const manifest = buildSpeakGenerativeUiManifest({
  basePath: process.env.BASE_PATH || '',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
})

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
