import 'dotenv/config'
import { buildSpeakChatGptAppManifest } from '../server/agent-contract.mjs'

const manifest = buildSpeakChatGptAppManifest({
  basePath: process.env.BASE_PATH || '',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
})

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
