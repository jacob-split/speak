import 'dotenv/config'
import { chromium } from 'playwright'
import { speakWidgetDocument } from '../server/speak-mcp.mjs'

const widgetHtml = speakWidgetDocument({
  basePath: '/speak',
  publicBaseUrl: 'https://speak.example.com/speak',
})
const failures = []
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

try {
  await page.setContent(
    `<!doctype html>
    <html>
      <body>
        <script>
          window.__speakMessages = [];
          window.addEventListener('message', (event) => {
            window.__speakMessages.push(event.data);
          });
        </script>
        <iframe id="speak-widget" srcdoc="${escapeAttribute(widgetHtml)}"></iframe>
      </body>
    </html>`,
  )

  const frameHandle = await page.waitForSelector('#speak-widget')
  const frame = await frameHandle.contentFrame()
  if (!frame) throw new Error('Could not resolve widget iframe')

  await waitForMessage(page, (message) => message.type === 'speak:ready')

  await frame.evaluate(
    () =>
      new Promise((resolve) => {
        window.postMessage(
          {
            type: 'speak:set-authorization-mode',
            detail: { authorizationMode: 'dangerously_approve_everything' },
          },
          '*',
        )
        setTimeout(resolve, 20)
      }),
  )
  const modeAfterSelfMessage = await frame.locator('#authorizationMode').inputValue()
  if (modeAfterSelfMessage === 'dangerously_approve_everything') {
    failures.push('Widget accepted authorizationMode mutation from a non-parent message')
  }

  await page.evaluate(() => {
    const iframe = document.querySelector('#speak-widget')
    iframe.contentWindow.postMessage(
      {
        type: 'speak:hydrate',
        detail: {
          authorizationMode: 'yolo',
          structuredContent: {
            surface: 'dialer',
            generatedAt: 'bridge-test',
            authorizationMode: 'yolo',
            health: { ok: true, configured: true },
            queue: {
              total: 1,
              ready: 1,
              leads: [
                {
                  id: 'lead-bridge-test',
                  company: 'Bridge Test Co',
                  name: 'Pat Bridge',
                  phone: '+15551234567',
                  status: 'Ready',
                },
              ],
            },
            profiles: {
              total: 0,
              items: [],
            },
            communicationThreads: {
              total: 1,
              items: [
                {
                  threadId: 'thread-bridge-test',
                  contactLabel: 'Bridge Test Co',
                  status: 'open',
                  channels: 'call, sms',
                  summary: 'Asked for a follow-up text.',
                },
              ],
            },
            recentCalls: {
              total: 0,
              items: [],
            },
          },
        },
      },
      '*',
    )
  })

  const hydrated = await waitForMessage(
    page,
    (message) =>
      message.type === 'speak:state' &&
      message.detail?.authorizationMode === 'yolo' &&
      message.detail?.output?.queue?.total === 1 &&
      message.detail?.output?.communicationThreads?.total === 1,
  )
  if (!hydrated.detail?.output?.queue?.leads?.[0]?.id) {
    failures.push('Hydrated state did not include the test lead')
  }

  await frame.locator('[data-fetch="lead:lead-bridge-test"]').click()
  const toolCall = await waitForMessage(
    page,
    (message) =>
      message.type === 'speak:tool-call' &&
      message.detail?.name === 'fetch' &&
      message.detail?.arguments?.id === 'lead:lead-bridge-test' &&
      message.detail?.arguments?.authorizationMode === 'yolo',
  )
  if (!toolCall.detail?.arguments?.authorizationMode) {
    failures.push('Generic tool-call message did not include authorizationMode')
  }

  await frame.locator('#primaryAction').click()
  await waitForMessage(
    page,
    (message) =>
      message.type === 'speak:follow-up' &&
      String(message.detail?.prompt || '').includes('authorizationMode: "yolo"'),
  )

  if (failures.length > 0) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2))
    process.exitCode = 1
  } else {
    console.log(
      JSON.stringify(
        {
          ok: true,
          bridge: 'speak.widget-postmessage.v1',
          verifiedMessages: ['speak:ready', 'speak:state', 'speak:tool-call', 'speak:follow-up'],
        },
        null,
        2,
      ),
    )
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        failures: [error instanceof Error ? error.message : String(error)],
      },
      null,
      2,
    ),
  )
  process.exitCode = 1
} finally {
  await browser.close()
}

async function waitForMessage(pageInstance, predicate) {
  const handle = await pageInstance.waitForFunction(
    (predicateSource) => {
      const predicateFn = new Function('message', `return (${predicateSource})(message)`)
      return window.__speakMessages.find((message) => predicateFn(message)) || null
    },
    predicate.toString(),
    { timeout: 5000 },
  )
  return handle.jsonValue()
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
