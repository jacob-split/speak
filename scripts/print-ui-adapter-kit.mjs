import 'dotenv/config'
import { buildSpeakUiAdapterKit } from '../server/agent-contract.mjs'

const publicBaseUrl =
  process.env.PUBLIC_BASE_URL || 'https://speak.example.com/speak'

console.log(
  JSON.stringify(
    buildSpeakUiAdapterKit({
      basePath: process.env.BASE_PATH || '/speak',
      publicBaseUrl,
    }),
    null,
    2,
  ),
)
