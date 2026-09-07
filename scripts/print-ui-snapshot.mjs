import 'dotenv/config'
import { renderSpeakUiSnapshot } from '../server/speak-mcp.mjs'

const basePath = process.env.BASE_PATH || '/speak'
const publicBaseUrl =
  process.env.PUBLIC_BASE_URL || 'https://speak.example.com/speak'
const apiRoot = process.env.SPEAK_API_ROOT || `${publicBaseUrl}/api`

console.log(
  JSON.stringify(
    await renderSpeakUiSnapshot({
      apiRoot,
      basePath,
      publicBaseUrl,
      surface: process.env.SPEAK_UI_SURFACE || 'dialer',
      limit: Number(process.env.SPEAK_UI_LIMIT || 12),
      authorizationMode: process.env.SPEAK_AUTHORIZATION_MODE,
    }),
    null,
    2,
  ),
)
