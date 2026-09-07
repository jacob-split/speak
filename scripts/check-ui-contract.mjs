import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { buildSpeakAgentContract } from '../server/agent-contract.mjs'

const baseUrl = String(
  process.env.SPEAK_QA_BASE_URL ||
    process.env.REAL_QA_BASE_URL ||
    'http://127.0.0.1:5173/speak',
).replace(/\/+$/, '')
const failConsole = process.env.SPEAK_QA_FAIL_CONSOLE === '1'
const expectedTitle = process.env.SPEAK_QA_EXPECTED_TITLE || 'Speak'
const onlyCallToolsAvailability =
  process.env.SPEAK_QA_ONLY_CALLTOOLS_AVAILABILITY === '1'
const onlyPlaygroundCallMethods =
  process.env.SPEAK_QA_ONLY_PLAYGROUND_CALL_METHODS === '1'

const viewports = [
  { name: 'desktop', width: 1378, height: 790 },
  { name: 'phone', width: 390, height: 844 },
]
const qaViewports =
  onlyCallToolsAvailability || onlyPlaygroundCallMethods ? [] : viewports

const contract = buildSpeakAgentContract({ basePath: '/speak' })
const routes = contract.frontend.automation.routeContracts
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const consoleEntries = []
const networkEntries = []
const failures = []
const summaries = []
const libraryWorkspaceSource = readFileSync('src/LibraryWorkspace.tsx', 'utf8')
const agentConfigWorkspaceSource = readFileSync('src/AgentConfigWorkspace.tsx', 'utf8')
const configurationTestSessionSource = readFileSync(
  'src/useConfigurationTestSession.ts',
  'utf8',
)
const deviceCallButtonSource = readFileSync('src/DeviceCallButton.tsx', 'utf8')
const providerCatalogLoaderSource = sourceBetween(
  agentConfigWorkspaceSource,
  'const loadSpeakOptions = useCallback',
  '\n  useEffect(() =>',
)
const providerCatalogRefreshEffectsSource = sourceBetween(
  agentConfigWorkspaceSource,
  providerCatalogLoaderSource,
  '\n  function updateDraftConfig',
)
const providerCatalogManualRefreshSource = sourceBetween(
  agentConfigWorkspaceSource,
  'async function refreshProfileAndOptions()',
  '\n  function selectProfile',
)
const playgroundProfileSelectionSource = sourceBetween(
  agentConfigWorkspaceSource,
  'function selectProfile(profile: AgentConfigProfile)',
  '\n  const newProfile',
)
const playgroundProfileDeepLinkSource = sourceBetween(
  agentConfigWorkspaceSource,
  "const profileId = params.get('profile')",
  '\n  async function saveProfile',
)
const playgroundProfileSaveSource = sourceBetween(
  agentConfigWorkspaceSource,
  'async function saveProfile(',
  '\n  const promptTestVariableFields',
)
const playgroundServerProfileHydrationSource = sourceBetween(
  agentConfigWorkspaceSource,
  'async function hydrateServerProfiles()',
  '\n    void hydrateServerProfiles()',
)
const playgroundNextSessionSaveSource = sourceBetween(
  agentConfigWorkspaceSource,
  'async function saveProfileForNextSession(',
  '\n  function buildConfigurationTestConfig',
)
for (const [source, snippet, message] of [
  [providerCatalogLoaderSource, "cache: 'no-store'", 'provider catalog fetch must bypass browser caches'],
  [providerCatalogLoaderSource, 'speakOptionsRequestRef.current?.abort()', 'provider catalog refresh must abort the previous request'],
  [providerCatalogLoaderSource, 'speakOptionsRequestRef.current !== controller', 'provider catalog refresh must reject stale responses'],
  [providerCatalogRefreshEffectsSource, 'if (settingsOpen) void loadSpeakOptions()', 'opening or reopening Settings must refresh provider options'],
  [providerCatalogRefreshEffectsSource, "window.addEventListener('focus', refreshSpeakOptions)", 'window focus must refresh provider options'],
  [providerCatalogRefreshEffectsSource, "document.addEventListener('visibilitychange', refreshVisibleSpeakOptions)", 'visibility restoration must refresh provider options'],
  [providerCatalogManualRefreshSource, 'Promise.all([refreshProfileFromHume(draft), loadSpeakOptions()])', 'profile Refresh must refresh provider options'],
]) {
  if (!source.includes(snippet)) failures.push(`Playground freshness contract: ${message}`)
}
for (const [source, snippet, message] of [
  [playgroundProfileSelectionSource, 'setActiveId(', 'profile list selection must remain editor-local'],
  [playgroundProfileSelectionSource, 'saveActiveAgentProfileId(', 'profile list selection must not replace the Dialer agent'],
  [playgroundProfileSelectionSource, 'persistProfiles(', 'profile list selection must not persist global activation'],
  [playgroundProfileDeepLinkSource, 'setActiveId(', 'profile deep links must remain editor-local'],
  [playgroundProfileDeepLinkSource, 'saveActiveAgentProfileId(', 'profile deep links must not replace the Dialer agent'],
  [playgroundProfileDeepLinkSource, 'persistProfiles(', 'profile deep links must not persist global activation'],
]) {
  if (source.includes(snippet)) failures.push(`Playground profile isolation contract: ${message}`)
}
for (const snippet of [
  'persistProfiles(provisionalProfiles, activeId)',
  'persistProfiles(next, activeId)',
]) {
  if (!playgroundProfileSaveSource.includes(snippet)) {
    failures.push(`Playground profile isolation contract: saves must preserve the active Dialer profile via ${snippet}`)
  }
}
for (const [source, snippet, message] of [
  [agentConfigWorkspaceSource, "dialerProvider: 'speak' as const", 'Phone tests must force the transient Speak/Telnyx transport'],
  [agentConfigWorkspaceSource, 'Speak/Telnyx phone-test caller ID', 'Phone tests must expose the selected Speak/Telnyx number with transport scope'],
  [configurationTestSessionSource, "modeRef.current = 'browser'", 'Browser tests must use the shared Playground session controller'],
  [configurationTestSessionSource, "modeRef.current = 'phone'", 'Phone tests must use the shared Playground session controller'],
  [configurationTestSessionSource, '/calls/${encodeURIComponent(targetSessionId)}/instructions', 'Phone composer messages must remain on the active phone session'],
  [deviceCallButtonSource, 'speakActionIds.callLeadFromDevice', 'Device calls must be identified as local tel handoffs'],
]) {
  if (!source.includes(snippet)) failures.push(`Playground call-method contract: ${message}`)
}
for (const [source, snippet, message] of [
  [agentConfigWorkspaceSource, 'const profileSwitchDisabled = !serverProfilesHydrated || playgroundSessionActive', 'profile switching must wait for saved server profiles'],
  [agentConfigWorkspaceSource, 'const testStartDisabled = !serverProfilesHydrated || playgroundSessionActive', 'Browser and Phone tests must wait for saved server profiles'],
  [playgroundNextSessionSaveSource, 'if (!serverProfilesHydrated)', 'session saves must fail closed before saved server profiles hydrate'],
  [playgroundNextSessionSaveSource, 'profiles.find((profile) => profile.id === draft.id)', 'clean saved profiles must be reused without another provider sync'],
  [playgroundNextSessionSaveSource, 'Object.values(dirtySections).some(Boolean)', 'only new or dirty profiles may be saved before a test starts'],
]) {
  if (!source.includes(snippet)) failures.push(`Playground profile hydration contract: ${message}`)
}
if (playgroundNextSessionSaveSource.includes('forceProviderSync: true')) {
  failures.push('Playground test starts must not force a full voice-provider sync')
}
if (/finally\s*\{[\s\S]{0,160}setServerProfilesHydrated\(true\)/.test(playgroundServerProfileHydrationSource)) {
  failures.push('Playground profile hydration contract: failed server profile loads must remain unhydrated')
}
if (!/thread\.sourceThreadIds\?\.join\(' '\)/.test(libraryWorkspaceSource)) {
  failures.push('Library activity thread search text must include grouped source thread IDs')
}
if (!/function communicationThreadMatchesId/.test(libraryWorkspaceSource)) {
  failures.push('Library activity deep links must resolve grouped source thread IDs')
}
if (!/setTranscriptSourceFilter\('all'\)/.test(libraryWorkspaceSource)) {
  failures.push('Library thread deep links must clear stale Activity filters')
}
if (!/recentCallContactIdForLeadIds/.test(libraryWorkspaceSource)) {
  failures.push('Library Activity must resolve recent calls through the selected contact source')
}
if (!/communicationThreadContactIdForLeadIds/.test(libraryWorkspaceSource)) {
  failures.push('Library Activity must scope communication threads to the selected contact source')
}
const libraryActivityChannelTargets = [
  { channel: 'email', summaryRouteId: 'library-activity-email' },
  { channel: 'sms', summaryRouteId: 'library-activity-sms' },
]

function sourceBetween(source, startMarker, endMarker) {
  const start = typeof startMarker === 'string' ? source.indexOf(startMarker) : -1
  if (start < 0) return ''
  const end = source.indexOf(endMarker, start + String(startMarker).length)
  return source.slice(start, end < 0 ? source.length : end)
}

page.on('console', (message) => {
  if (['error', 'warning'].includes(message.type())) {
    consoleEntries.push({
      type: message.type(),
      text: message.text(),
      location: message.location(),
    })
  }
})

page.on('response', (response) => {
  if (response.status() >= 500 && isAppNetworkUrl(response.url())) {
    networkEntries.push({
      type: 'response',
      method: response.request().method(),
      status: response.status(),
      url: response.url(),
    })
  }
})

page.on('requestfailed', (request) => {
  if (!isAppNetworkUrl(request.url())) return
  const errorText = request.failure()?.errorText || ''
  if (isIgnorableRequestFailure(request, errorText)) return
  networkEntries.push({
    type: 'requestfailed',
    method: request.method(),
    status: 0,
    url: request.url(),
    errorText,
  })
})

try {
  for (const viewport of qaViewports) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    })

    for (const route of routes) {
      const url = route.path === '/' ? `${baseUrl}/` : `${baseUrl}${route.path}`
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
      if (route.routeId === 'configs' && viewport.name === 'phone') {
        await page
          .getByRole('button', { name: 'Show prompt' })
          .click({ timeout: 2000 })
          .catch(() => {})
      }

      const pageTitle = await page.title()
      const metrics = await page.evaluate(
        ({ route, viewport }) => {
          const bodyText = document.body.innerText?.replace(/\s+/g, ' ').trim() || ''
          const requiredTestIds = [
            ...route.criticalTestIds,
            ...(viewport.name === 'desktop' ? route.desktopOnlyTestIds || [] : []),
            ...(viewport.name === 'phone' ? route.phoneOnlyTestIds || [] : []),
          ]
          const boxForTestId = (testId) => {
            const nodes = Array.from(
              document.querySelectorAll(`[data-testid="${testId}"]`),
            )
            const hasVisibleChildBox = (element) =>
              Array.from(element.querySelectorAll('*')).some((child) => {
                const childRect = child.getBoundingClientRect()
                const childStyle = getComputedStyle(child)
                return (
                  childStyle.display !== 'none' &&
                  childStyle.visibility !== 'hidden' &&
                  childRect.width > 0 &&
                  childRect.height > 0
                )
              })
            const visibleNodes = nodes
              .map((node) => {
                const element = node
                const rect = element.getBoundingClientRect()
                const style = getComputedStyle(element)
                const hasOwnBox = rect.width > 0 && rect.height > 0
                return {
                  display: style.display,
                  height: Math.round(rect.height),
                  visible:
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (hasOwnBox ||
                      (style.display === 'contents' && hasVisibleChildBox(element))),
                  width: Math.round(rect.width),
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                }
              })
              .filter((entry) => entry.visible)
            return {
              count: nodes.length,
              visibleCount: visibleNodes.length,
              firstVisible: visibleNodes[0] || null,
            }
          }
          const computedDisplay = (selector) => {
            const node = document.querySelector(selector)
            return node ? getComputedStyle(node).display : null
          }
          const visibleBox = (selector) => {
            const node = document.querySelector(selector)
            if (!node) return null
            const rect = node.getBoundingClientRect()
            const style = getComputedStyle(node)
            return {
              display: style.display,
              visible:
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                rect.width > 0 &&
                rect.height > 0,
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              gap: Math.round(parseFloat(style.columnGap || style.gap || '0') || 0),
            }
          }
          const routeNavItems = Array.from(
            document.querySelectorAll('.app-primary-nav [data-route-nav-id]'),
          ).map((node) => {
            const rect = node.getBoundingClientRect()
            const style = getComputedStyle(node)
            return {
              id: node.getAttribute('data-route-nav-id'),
              visible:
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                rect.width > 0 &&
                rect.height > 0,
              width: Math.round(rect.width),
              x: Math.round(rect.x),
              y: Math.round(rect.y),
            }
          })
          const activeRouteNav = document.querySelector(
            '.app-primary-nav [aria-current="page"]',
          )
          const activeRouteContent = activeRouteNav?.querySelector('.app-nav-content')
          const activeRouteLabels = {
            configs: 'Playground',
            dialer: 'Dialer',
            library: 'Library',
          }
          const activeRouteContentBox = activeRouteContent
            ? (() => {
                const rect = activeRouteContent.getBoundingClientRect()
                const style = getComputedStyle(activeRouteContent)
                return {
                  display: style.display,
                  visible:
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    rect.width > 0 &&
                    rect.height > 0,
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                }
              })()
            : null
          const routeNode = document.querySelector(`[data-route-id="${route.routeId}"]`)
          return {
            bodyTextSample: bodyText.slice(0, 800),
            hasMeaningfulText:
              bodyText.length > 20 &&
              /Library|Dialer|Playground|Contacts|Activity|Agents|Calls|Prompt/i.test(bodyText),
            hasFrameworkOverlay:
              /vite|webpack|next\.js|react error overlay|runtime error|failed to compile|uncaught error/i.test(bodyText),
            critical: Object.fromEntries(
              requiredTestIds.map((testId) => [testId, boxForTestId(testId)]),
            ),
            routeId: routeNode?.getAttribute('data-route-id') || null,
            overflowX:
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
            topbar: visibleBox('.topbar'),
            primaryRouteNav: visibleBox('.app-primary-nav'),
            primaryRouteNavText:
              document
                .querySelector('.app-primary-nav')
                ?.textContent?.trim()
                .replace(/\s+/g, ' ') || '',
            activeRouteLabel: activeRouteLabels[route.routeId] || '',
            routeNavItems,
            activeRouteNav: visibleBox('.app-primary-nav [aria-current="page"]'),
            activeRouteContent: activeRouteContentBox,
            dialerSetup: visibleBox('[data-testid="speak-dialer-run-controls"]'),
            dialerSetupTrigger: visibleBox('.dialer-topbar .dialer-setup-trigger'),
            globalSearch: visibleBox('[data-testid="speak-global-search-trigger"]'),
            appearance: visibleBox('[data-testid="speak-appearance-trigger"]'),
            topbarActiveAgentPills: Array.from(
              document.querySelectorAll('.topbar [data-testid="speak-active-agent-pill"]'),
            ).filter((node) => {
              const rect = node.getBoundingClientRect()
              const style = getComputedStyle(node)
              return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                rect.width > 0 &&
                rect.height > 0
              )
            }).length,
            viewport: viewport.name,
          }
        },
        { route, viewport },
      )

      summaries.push({
        routeId: route.routeId,
        url,
        viewport: viewport.name,
        pageTitle,
        hasMeaningfulText: metrics.hasMeaningfulText,
        hasFrameworkOverlay: metrics.hasFrameworkOverlay,
        overflowX: metrics.overflowX,
        topbar: metrics.topbar,
        primaryRouteNav: metrics.primaryRouteNav,
        primaryRouteNavText: metrics.primaryRouteNavText,
        routeNavItems: metrics.routeNavItems,
        activeRouteNav: metrics.activeRouteNav,
        activeRouteContent: metrics.activeRouteContent,
        dialerSetup: metrics.dialerSetup,
        dialerSetupTrigger: metrics.dialerSetupTrigger,
        globalSearch: metrics.globalSearch,
        appearance: metrics.appearance,
        topbarActiveAgentPills: metrics.topbarActiveAgentPills,
      })

      if (pageTitle !== expectedTitle) {
        failures.push(
          `${viewport.name} ${route.routeId}: expected page title "${expectedTitle}", saw "${pageTitle}"`,
        )
      }

      if (!metrics.hasMeaningfulText) {
        failures.push(
          `${viewport.name} ${route.routeId}: rendered page did not expose meaningful Speak content`,
        )
      }

      if (metrics.hasFrameworkOverlay) {
        failures.push(
          `${viewport.name} ${route.routeId}: rendered page appears to show a framework/runtime error overlay`,
        )
      }

      if (metrics.routeId !== route.routeId) {
        failures.push(
          `${viewport.name} ${route.routeId}: expected route id ${route.routeId}, saw ${metrics.routeId}`,
        )
      }

      if (metrics.overflowX > 0) {
        failures.push(
          `${viewport.name} ${route.routeId}: horizontal overflow ${metrics.overflowX}px`,
        )
      }

      Object.entries(metrics.critical).forEach(([testId, result]) => {
        if (result.count === 0 || result.visibleCount === 0) {
          failures.push(
            `${viewport.name} ${route.routeId}: missing visible [data-testid="${testId}"]`,
          )
        }
      })

      if (!metrics.activeRouteNav?.visible) {
        failures.push(
          `${viewport.name} ${route.routeId}: missing visible active primary nav item`,
        )
      }

      if (metrics.primaryRouteNav?.visible) {
        const visibleRouteItems = metrics.routeNavItems
          .filter((item) => item.visible)
          .sort((left, right) => left.x - right.x)
        const expectedRouteOrder = ['library', 'dialer', 'configs']
        const routeOrder = visibleRouteItems.map((item) => item.id)
        if (routeOrder.join(',') !== expectedRouteOrder.join(',')) {
          failures.push(
            `${viewport.name} ${route.routeId}: route dock order ${routeOrder.join(',')} should remain ${expectedRouteOrder.join(',')}`,
          )
        }
        const expectedSlotItems = expectedRouteOrder
          .map((id) => visibleRouteItems.find((item) => item.id === id))
          .filter(Boolean)
        for (let index = 1; index < expectedSlotItems.length; index += 1) {
          const previous = expectedSlotItems[index - 1]
          const current = expectedSlotItems[index]
          const previousRight = previous.x + previous.width
          if (current.x < previousRight - 1) {
            failures.push(
              `${viewport.name} ${route.routeId}: route dock item ${current.id} overlaps ${previous.id}; active labels must stay in their fixed slots`,
            )
          }
        }
        const activeRouteIndex = routeOrder.indexOf(route.routeId)
        const expectedActiveRouteIndex = expectedRouteOrder.indexOf(route.routeId)
        if (activeRouteIndex !== expectedActiveRouteIndex) {
          failures.push(
            `${viewport.name} ${route.routeId}: active route rendered in slot ${activeRouteIndex}, expected fixed ${expectedActiveRouteIndex}`,
          )
        }
      }

      if (viewport.name === 'desktop' && metrics.primaryRouteNav?.visible) {
        const visibleRouteItems = metrics.routeNavItems
          .filter((item) => item.visible)
          .sort((left, right) => left.x - right.x)
        const inactiveRouteItems = visibleRouteItems.filter(
          (item) => item.id !== route.routeId,
        )
        const routeTrackEnd = metrics.primaryRouteNav.x + metrics.primaryRouteNav.width
        const routeItemsEnd = visibleRouteItems.reduce(
          (max, item) => Math.max(max, item.x + item.width),
          0,
        )
        if (routeItemsEnd - routeTrackEnd > 2) {
          failures.push(
            `${viewport.name} ${route.routeId}: visible route controls overflow the reserved primary nav track`,
          )
        }
        if (metrics.primaryRouteNav.width > 210) {
          failures.push(
            `${viewport.name} ${route.routeId}: primary route nav track ${metrics.primaryRouteNav.width}px is too wide for compact left chrome`,
          )
        }
        for (const item of inactiveRouteItems) {
          if (item.width > 36) {
            failures.push(
              `${viewport.name} ${route.routeId}: inactive route ${item.id} should remain icon-only, saw ${item.width}px`,
            )
          }
        }
        if (
          metrics.activeRouteNav?.visible &&
          metrics.activeRouteContent?.visible &&
          metrics.activeRouteNav.width - metrics.activeRouteContent.width > 6
        ) {
          failures.push(
            `${viewport.name} ${route.routeId}: active route slot ${metrics.activeRouteNav.width}px is not filled by its visible content track ${metrics.activeRouteContent.width}px`,
          )
        }
        if (metrics.globalSearch?.visible) {
          const routeToSearchGap = metrics.globalSearch.x -
            (metrics.primaryRouteNav.x + metrics.primaryRouteNav.width)
          if (routeToSearchGap > 12) {
            failures.push(
              `${viewport.name} ${route.routeId}: search drifted ${routeToSearchGap}px from primary route nav; expected <= 12px`,
            )
          }
        }
        if (metrics.globalSearch?.visible && metrics.appearance?.visible) {
          const searchToAppearanceGap = metrics.appearance.x -
            (metrics.globalSearch.x + metrics.globalSearch.width)
          if (searchToAppearanceGap > 8) {
            failures.push(
              `${viewport.name} ${route.routeId}: appearance drifted ${searchToAppearanceGap}px from global search; expected <= 8px`,
            )
          }
        }
        if (metrics.primaryRouteNavText !== metrics.activeRouteLabel) {
          failures.push(
            `${viewport.name} ${route.routeId}: route dock text leaked "${metrics.primaryRouteNavText}"; expected only "${metrics.activeRouteLabel}"`,
          )
        }
      }

      if (viewport.name === 'desktop' && route.routeId === 'dialer') {
        if (!metrics.dialerSetupTrigger?.visible) {
          failures.push('desktop dialer: missing visible dialer setup trigger')
        } else {
          const expectedY = (metrics.topbar?.y || 0) + 46
          const setupYDrift = Math.abs(metrics.dialerSetupTrigger.y - expectedY)
          if (setupYDrift > 3) {
            failures.push(
              `desktop dialer: setup bar y=${metrics.dialerSetupTrigger.y}px should align with second topbar row at ${expectedY}px`,
            )
          }
          if (
            metrics.topbar?.visible &&
            Math.abs(metrics.dialerSetupTrigger.x - (metrics.topbar.x + 6)) > 2
          ) {
            failures.push(
              `desktop dialer: setup bar x=${metrics.dialerSetupTrigger.x}px should align inside the left panel at ${metrics.topbar.x + 6}px`,
            )
          }
          if (
            metrics.topbar?.visible &&
            metrics.dialerSetupTrigger.width < metrics.topbar.width - 20
          ) {
            failures.push(
              `desktop dialer: setup bar width ${metrics.dialerSetupTrigger.width}px should span the left panel topbar width ${metrics.topbar.width}px`,
            )
          }
          const setupRight =
            metrics.dialerSetupTrigger.x + metrics.dialerSetupTrigger.width
          const topbarRight = (metrics.topbar?.x || 0) + (metrics.topbar?.width || 0)
          if (
            metrics.topbar?.visible &&
            Math.abs(setupRight - (topbarRight - 6)) > 2
          ) {
            failures.push(
              `desktop dialer: setup bar right edge ${setupRight}px should align inside the left panel at ${topbarRight - 6}px`,
            )
          }
          if (topbarRight > 0 && setupRight - topbarRight > 2) {
            failures.push(
              `desktop dialer: setup bar overflows the left panel by ${setupRight - topbarRight}px`,
            )
          }
        }
      }

      if (metrics.topbarActiveAgentPills > 0) {
        failures.push(
          `${viewport.name} ${route.routeId}: active-agent pill should not render in persistent chrome`,
        )
      }

      if (metrics.globalSearch?.visible) {
        await verifyGlobalSearchInteraction({
          failures,
          page,
          routeId: route.routeId,
          summaries,
          viewportName: viewport.name,
        })
      }

      if (metrics.appearance?.visible) {
        await verifyAppearanceInteraction({
          failures,
          page,
          routeId: route.routeId,
          summaries,
          viewportName: viewport.name,
        })
      }

      if (route.routeId === 'dialer' && metrics.dialerSetupTrigger?.visible) {
        await verifyDialerSetupInteraction({
          failures,
          page,
          summaries,
          viewportName: viewport.name,
        })
      }

      if (route.routeId === 'library') {
        await verifyLibraryActivityRendering(page, viewport.name, failures, summaries)
      }

      if (viewport.name === 'desktop') {
        if (
          route.routeId !== 'configs' &&
          (!metrics.topbar?.visible || metrics.topbar.width > 320)
        ) {
          failures.push(
            `${viewport.name} ${route.routeId}: desktop persistent chrome should be a compact left island`,
          )
        }
        if (
          route.routeId === 'configs' &&
          (!metrics.topbar?.visible || metrics.topbar.width < 320)
        ) {
          failures.push(
            `${viewport.name} ${route.routeId}: desktop playground chrome should include the centered profile selector`,
          )
        }
      }
    }

    await verifyGlobalSearchFixtureActivation({
      failures,
      page,
      summaries,
      viewportName: viewport.name,
    })

    await verifyLibraryContactMutationFixture({
      failures,
      page,
      summaries,
      viewportName: viewport.name,
    })
  }

  if (!onlyCallToolsAvailability && !onlyPlaygroundCallMethods) {
    await verifyPlaygroundProfileSelectionIsolation({
      baseUrl,
      failures,
      page,
      summaries,
    })
  }
  if (!onlyCallToolsAvailability) {
    await verifyPlaygroundCallMethods({
      baseUrl,
      browser,
      failures,
      summaries,
    })
  }
  if (!onlyPlaygroundCallMethods) {
    await verifyCallToolsAvailabilityRoutePersistence({
      baseUrl,
      failures,
      page,
      summaries,
    })
  }

  qaViewports.forEach((viewport) => {
    const routeSummaries = summaries.filter(
      (summary) => summary.viewport === viewport.name,
    )
    const searchXs = routeSummaries
      .map((summary) => summary.globalSearch?.x)
      .filter((x) => Number.isFinite(x))
    if (searchXs.length > 1) {
      const drift = Math.max(...searchXs) - Math.min(...searchXs)
      if (drift > 2) {
        failures.push(
          `${viewport.name} route chrome drifted ${drift}px between Library, Dialer, and Playground search positions`,
        )
      }
    }
    const routeNavWidths = routeSummaries
      .map((summary) => summary.primaryRouteNav?.width)
      .filter((width) => Number.isFinite(width))
    if (routeNavWidths.length > 1) {
      const drift = Math.max(...routeNavWidths) - Math.min(...routeNavWidths)
      if (drift > 2) {
        failures.push(
          `${viewport.name} route dock width drifted ${drift}px between Library, Dialer, and Playground`,
        )
      }
    }
  })

  const relevantConsoleEntries = consoleEntries.filter((entry) =>
    ['error', 'warning'].includes(entry.type) && !isIgnorableConsoleEntry(entry),
  )
  if (failConsole && relevantConsoleEntries.length > 0) {
    failures.push(
      `browser console issues: ${relevantConsoleEntries.map((entry) => `${entry.type}:${entry.text}`).join(' | ')}`,
    )
  }
  if (failConsole && networkEntries.length > 0) {
    failures.push(
      `browser network issues: ${networkEntries.map((entry) =>
        [
          entry.type,
          entry.method,
          entry.status || entry.errorText || '',
          entry.url,
        ].filter(Boolean).join(':'),
      ).join(' | ')}`,
    )
  }

  if (failures.length > 0) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          baseUrl,
          failures,
          consoleEntries,
          networkEntries,
          summaries,
        },
        null,
        2,
      ),
    )
    process.exitCode = 1
  } else {
    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl,
          consoleWarnings: consoleEntries.filter(
            (entry) => entry.type === 'warning',
          ).length,
          networkIssues: networkEntries.length,
          summaries,
        },
        null,
        2,
      ),
    )
  }
} finally {
  await browser.close()
}

async function verifyGlobalSearchInteraction({
  failures,
  page,
  routeId,
  summaries,
  viewportName,
}) {
  const beforeUrl = page.url()
  try {
    await page.getByTestId('speak-global-search-trigger').click({ timeout: 3000 })
  } catch (error) {
    failures.push(
      `${viewportName} ${routeId}: global search trigger did not open (${error instanceof Error ? error.message : String(error)})`,
    )
    return
  }

  await page
    .waitForSelector('[data-testid="speak-global-search-dialog"]', {
      state: 'visible',
      timeout: 5000,
    })
    .catch(() => {})
  await page
    .waitForFunction(() => {
      const dialog = document.querySelector('[data-testid="speak-global-search-dialog"]')
      const text = dialog?.textContent || ''
      return (
        (dialog?.querySelectorAll('.global-search-result').length || 0) > 0 ||
        /No results/i.test(text)
      )
    }, null, { timeout: 7000 })
    .catch(() => {})

  const openMetrics = await collectGlobalSearchMetrics(page)
  summaries.push({
    routeId: `global-search-${routeId}`,
    viewport: viewportName,
    phase: 'open',
    ...openMetrics,
  })

  if (!openMetrics.dialogVisible) {
    failures.push(`${viewportName} ${routeId}: global search dialog was not visible after opening`)
    return
  }
  if (!openMetrics.inputVisible) {
    failures.push(`${viewportName} ${routeId}: global search input is not visible`)
  }
  if (!openMetrics.inputFocused) {
    failures.push(`${viewportName} ${routeId}: global search input was not focused after opening`)
  }
  if (!openMetrics.listboxVisible) {
    failures.push(`${viewportName} ${routeId}: global search results listbox is not visible`)
  }
  if (openMetrics.resultCount < 1) {
    failures.push(
      `${viewportName} ${routeId}: global search did not render indexed workspace results`,
    )
  }
  if (openMetrics.overflowX > 0) {
    failures.push(
      `${viewportName} ${routeId}: global search dialog overflows viewport horizontally by ${openMetrics.overflowX}px`,
    )
  }
  if (openMetrics.bodyOverflow !== 'hidden') {
    failures.push(
      `${viewportName} ${routeId}: global search did not lock body scrolling while open`,
    )
  }

  const input = page.locator('[data-testid="speak-global-search-dialog"] input').first()
  await input.fill('__speak_no_result_probe__')
  await page
    .waitForFunction(() => {
      const dialog = document.querySelector('[data-testid="speak-global-search-dialog"]')
      return /No results/i.test(dialog?.textContent || '')
    }, null, { timeout: 3000 })
    .catch(() => {})
  const emptyMetrics = await collectGlobalSearchMetrics(page)
  summaries.push({
    routeId: `global-search-${routeId}`,
    viewport: viewportName,
    phase: 'empty-query',
    ...emptyMetrics,
  })
  if (!emptyMetrics.emptyStateVisible || emptyMetrics.resultCount !== 0) {
    failures.push(
      `${viewportName} ${routeId}: global search empty-query state did not replace stale results`,
    )
  }

  await page.keyboard.press('Escape')
  await page
    .waitForSelector('[data-testid="speak-global-search-dialog"]', {
      state: 'detached',
      timeout: 3000,
    })
    .catch(() => {})
  const closeMetrics = await collectGlobalSearchMetrics(page)
  summaries.push({
    routeId: `global-search-${routeId}`,
    viewport: viewportName,
    phase: 'closed',
    ...closeMetrics,
  })
  if (closeMetrics.dialogVisible) {
    failures.push(`${viewportName} ${routeId}: global search did not close on Escape`)
  }
  if (page.url() !== beforeUrl) {
    failures.push(`${viewportName} ${routeId}: global search interaction changed URL unexpectedly`)
  }
}

async function collectGlobalSearchMetrics(page) {
  return page.evaluate(() => {
    const isVisible = (node) => {
      if (!node) return false
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      )
    }
    const dialog = document.querySelector('[data-testid="speak-global-search-dialog"]')
    const input = dialog?.querySelector('input') || null
    const listbox = dialog?.querySelector('[role="listbox"]') || null
    const resultNodes = Array.from(dialog?.querySelectorAll('.global-search-result') || [])
      .filter(isVisible)
    const dialogRect = dialog?.getBoundingClientRect()
    const overflowX = dialogRect
      ? Math.max(0, -dialogRect.left, dialogRect.right - window.innerWidth)
      : 0
    const resultKinds = Array.from(new Set(resultNodes.flatMap((node) =>
      Array.from(node.classList)
        .filter((className) => className.startsWith('search-kind-'))
        .map((className) => className.replace(/^search-kind-/, '')),
    )))
    return {
      dialogVisible: isVisible(dialog),
      inputVisible: isVisible(input),
      inputFocused: document.activeElement === input,
      inputValue: input?.value || '',
      listboxVisible: isVisible(listbox),
      resultCount: resultNodes.length,
      resultKinds,
      emptyStateVisible: /No results/i.test(dialog?.textContent || ''),
      bodyOverflow: document.body.style.overflow || '',
      overflowX: Math.round(overflowX),
    }
  })
}

async function verifyLibraryContactMutationFixture({
  failures,
  page,
  summaries,
  viewportName,
}) {
  const fixture = createLibraryMutationFixture(viewportName)
  const cleanup = await installLibraryMutationFixtureRoutes(page, fixture)
  const alphaId = fixture.leads[0].id
  const betaId = fixture.leads[1].id
  const calltoolsId = fixture.leads[2].id
  const updatedCompany = `QA Alpha Updated ${viewportName}`

  try {
    await page.goto(`${baseUrl}/library`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
    await page
      .waitForSelector(`.contact-library-row[data-lead-id="${cssAttributeValue(alphaId)}"]`, {
        state: 'visible',
        timeout: 5000,
      })
      .catch(() => {})

    const initialMetrics = await collectLibraryMutationFixtureMetrics(page, {
      alphaId,
      betaId,
      calltoolsId,
      updatedCompany,
    })
    summaries.push({
      routeId: 'library-contact-mutation-fixture',
      viewport: viewportName,
      phase: 'initial',
      ...initialMetrics,
    })
    if (!initialMetrics.alphaVisible || !initialMetrics.betaVisible) {
      failures.push(`${viewportName} library contact fixture: expected both fixture contacts to render`)
      return
    }
    if (initialMetrics.calltoolsVisible) {
      failures.push(`${viewportName} library contact fixture: CallTools contact leaked into Personal Phone source`)
    }

    await page.getByTestId('speak-library-activity-tab').click({ timeout: 3000 })
    await page
      .waitForSelector(`.transcript-library-row[data-thread-id="${cssAttributeValue(fixture.personalThreadId)}"]`, {
        state: 'visible',
        timeout: 4000,
      })
      .catch(() => {})
    const initialActivityMetrics = await collectLibraryActivitySourceFixtureMetrics(page, {
      personalThreadId: fixture.personalThreadId,
      calltoolsThreadId: fixture.calltoolsThreadId,
    })
    summaries.push({
      routeId: 'library-activity-source-fixture',
      viewport: viewportName,
      phase: 'personal-selected',
      ...initialActivityMetrics,
    })
    if (!initialActivityMetrics.personalActivityVisible) {
      failures.push(`${viewportName} library activity fixture: Personal Phone source did not render its activity`)
    }
    if (initialActivityMetrics.calltoolsActivityVisible) {
      failures.push(`${viewportName} library activity fixture: CallTools activity leaked into Personal Phone source`)
    }

    await page.getByRole('tab', { name: 'Contacts' }).click({ timeout: 3000 })
    await page
      .locator('.library-source-list .library-view')
      .filter({ hasText: 'CallTools 1.0 Contacts' })
      .click({ timeout: 3000 })
    await page
      .waitForSelector(`.contact-library-row[data-lead-id="${cssAttributeValue(calltoolsId)}"]`, {
        state: 'visible',
        timeout: 4000,
      })
      .catch(() => {})
    const calltoolsSourceMetrics = await collectLibraryMutationFixtureMetrics(page, {
      alphaId,
      betaId,
      calltoolsId,
      updatedCompany,
    })
    summaries.push({
      routeId: 'library-contact-source-fixture',
      viewport: viewportName,
      phase: 'calltools-selected',
      ...calltoolsSourceMetrics,
    })
    if (!calltoolsSourceMetrics.calltoolsVisible) {
      failures.push(`${viewportName} library contact fixture: CallTools source did not render its contact`)
    }
    if (calltoolsSourceMetrics.alphaVisible || calltoolsSourceMetrics.betaVisible) {
      failures.push(`${viewportName} library contact fixture: Personal Phone contacts leaked into CallTools source`)
    }

    await page.getByTestId('speak-library-activity-tab').click({ timeout: 3000 })
    await page
      .waitForSelector(`.transcript-library-row[data-thread-id="${cssAttributeValue(fixture.calltoolsThreadId)}"]`, {
        state: 'visible',
        timeout: 4000,
      })
      .catch(() => {})
    const calltoolsActivityMetrics = await collectLibraryActivitySourceFixtureMetrics(page, {
      personalThreadId: fixture.personalThreadId,
      calltoolsThreadId: fixture.calltoolsThreadId,
    })
    summaries.push({
      routeId: 'library-activity-source-fixture',
      viewport: viewportName,
      phase: 'calltools-selected',
      ...calltoolsActivityMetrics,
    })
    if (!calltoolsActivityMetrics.calltoolsActivityVisible) {
      failures.push(`${viewportName} library activity fixture: CallTools source did not render its activity`)
    }
    if (calltoolsActivityMetrics.personalActivityVisible) {
      failures.push(`${viewportName} library activity fixture: Personal Phone activity leaked into CallTools source`)
    }

    await page.getByRole('tab', { name: 'Contacts' }).click({ timeout: 3000 })
    await page
      .locator('.library-source-list .library-view')
      .filter({ hasText: 'Personal Phone Contacts' })
      .click({ timeout: 3000 })
    await page
      .waitForSelector(`.contact-library-row[data-lead-id="${cssAttributeValue(alphaId)}"]`, {
        state: 'visible',
        timeout: 4000,
      })
      .catch(() => {})

    await page
      .locator(`.contact-library-row[data-lead-id="${cssAttributeValue(alphaId)}"] .contact-library-main`)
      .click({ timeout: 3000 })
    await page
      .waitForSelector(`.contact-library-row[data-lead-id="${cssAttributeValue(alphaId)}"] .contact-library-preview`, {
        state: 'visible',
        timeout: 3000,
      })
      .catch(() => {})

    const businessInput = page.locator(
      `.contact-library-row[data-lead-id="${cssAttributeValue(alphaId)}"] .contact-library-preview input[aria-label="QA Alpha Co Business"]`,
    )
    const patchResponse = page
      .waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          response.url().includes(`/api/leads/${encodeURIComponent(alphaId)}`),
        { timeout: 4000 },
      )
      .catch(() => null)
    await businessInput.fill(updatedCompany)
    await businessInput.evaluate((node) => node.blur())
    await patchResponse
    await page
      .waitForFunction(
        ({ leadId, expectedCompany }) =>
          document
            .querySelector(`.contact-library-row[data-lead-id="${CSS.escape(leadId)}"] .contact-library-title`)
            ?.textContent?.trim() === expectedCompany,
        { leadId: alphaId, expectedCompany: updatedCompany },
        { timeout: 4000 },
      )
      .catch(() => {})

    const afterEditMetrics = await collectLibraryMutationFixtureMetrics(page, {
      alphaId,
      betaId,
      calltoolsId,
      updatedCompany,
    })
    summaries.push({
      routeId: 'library-contact-mutation-fixture',
      viewport: viewportName,
      phase: 'after-edit',
      patchRequests: fixture.patchRequests,
      ...afterEditMetrics,
    })
    const editPatch = fixture.patchRequests.find((request) => request.id === alphaId)
    if (editPatch?.patch?.company !== updatedCompany) {
      failures.push(`${viewportName} library contact fixture: company edit did not PATCH the expected payload`)
    }
    if (!afterEditMetrics.alphaUpdatedVisible) {
      failures.push(`${viewportName} library contact fixture: company edit did not update the rendered row`)
    }

    const betaRow = page.locator(`.contact-library-row[data-lead-id="${cssAttributeValue(betaId)}"]`)
    await betaRow.hover({ timeout: 3000 })
    await page
      .waitForFunction(
        (leadId) => {
          const control = document.querySelector(
            `.contact-library-row[data-lead-id="${CSS.escape(leadId)}"] .contact-library-row-select`,
          )
          if (!control) return false
          const style = getComputedStyle(control)
          return style.pointerEvents !== 'none' && Number.parseFloat(style.opacity || '0') > 0.8
        },
        betaId,
        { timeout: 3000 },
      )
      .catch(() => {})
    await betaRow.locator('.contact-library-row-select').click({ timeout: 3000 })
    await page.locator('.bulk-status-select').selectOption('follow-up')
    await waitForUiContractCondition(() => fixture.bulkStatusRequests.length > 0)
    await page
      .waitForFunction(
        (leadId) =>
          document
            .querySelector(`.contact-library-row[data-lead-id="${CSS.escape(leadId)}"] .contact-library-status select`)
            ?.value === 'follow-up',
        betaId,
        { timeout: 4000 },
      )
      .catch(() => {})

    const afterBulkStatusMetrics = await collectLibraryMutationFixtureMetrics(page, {
      alphaId,
      betaId,
      calltoolsId,
      updatedCompany,
    })
    summaries.push({
      routeId: 'library-contact-mutation-fixture',
      viewport: viewportName,
      phase: 'after-bulk-status',
      bulkStatusRequests: fixture.bulkStatusRequests,
      ...afterBulkStatusMetrics,
    })
    const statusRequest = fixture.bulkStatusRequests.at(-1)
    if (
      statusRequest?.status !== 'follow-up' ||
      !Array.isArray(statusRequest.ids) ||
      statusRequest.ids.length !== 1 ||
      statusRequest.ids[0] !== betaId
    ) {
      failures.push(`${viewportName} library contact fixture: bulk status did not POST the selected contact/status`)
    }
    if (!afterBulkStatusMetrics.betaFollowUp) {
      failures.push(`${viewportName} library contact fixture: bulk status did not update the selected contact row`)
    }

    const bulkDeleteResponse = page
      .waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().includes('/api/leads/bulk-delete'),
        { timeout: 4000 },
      )
      .catch(() => null)
    await page
      .getByRole('button', { name: 'Delete selected contacts' })
      .click({ timeout: 3000 })
    await bulkDeleteResponse
    await waitForUiContractCondition(() => fixture.bulkDeleteRequests.length > 0)
    await page
      .waitForFunction(
        (leadId) => !document.querySelector(`.contact-library-row[data-lead-id="${CSS.escape(leadId)}"]`),
        betaId,
        { timeout: 4000 },
      )
      .catch(() => {})

    const afterBulkDeleteMetrics = await collectLibraryMutationFixtureMetrics(page, {
      alphaId,
      betaId,
      calltoolsId,
      updatedCompany,
    })
    summaries.push({
      routeId: 'library-contact-mutation-fixture',
      viewport: viewportName,
      phase: 'after-bulk-delete',
      bulkDeleteRequests: fixture.bulkDeleteRequests,
      ...afterBulkDeleteMetrics,
    })
    const deleteRequest = fixture.bulkDeleteRequests.at(-1)
    if (
      !Array.isArray(deleteRequest?.ids) ||
      deleteRequest.ids.length !== 1 ||
      deleteRequest.ids[0] !== betaId
    ) {
      failures.push(`${viewportName} library contact fixture: bulk delete did not POST the selected contact id`)
    }
    if (afterBulkDeleteMetrics.betaVisible) {
      failures.push(`${viewportName} library contact fixture: bulk delete did not remove the selected contact row`)
    }
    if (!afterBulkDeleteMetrics.alphaUpdatedVisible) {
      failures.push(`${viewportName} library contact fixture: bulk delete disturbed the edited contact row`)
    }

    const createResponse = page
      .waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          /\/api\/leads$/.test(new URL(response.url()).pathname),
        { timeout: 4000 },
      )
      .catch(() => null)
    await page.getByTestId('speak-add-lead-button').click({ timeout: 3000 })
    await createResponse
    await waitForUiContractCondition(() => fixture.createRequests.length > 0)
    const afterCreateMetrics = await collectLibraryMutationFixtureMetrics(page, {
      alphaId,
      betaId,
      calltoolsId,
      updatedCompany,
    })
    summaries.push({
      routeId: 'library-contact-source-fixture',
      viewport: viewportName,
      phase: 'after-personal-add',
      createRequests: fixture.createRequests,
      ...afterCreateMetrics,
    })
    const createRequest = fixture.createRequests.at(-1)
    if (
      createRequest?.source !== 'personal-phone' ||
      createRequest?.sourceId !== 'bluebubbles:contacts'
    ) {
      failures.push(`${viewportName} library contact fixture: add contact did not use the selected Personal Phone source`)
    }
  } catch (error) {
    failures.push(
      `${viewportName} library contact fixture: mutation check failed (${error instanceof Error ? error.message : String(error)})`,
    )
  } finally {
    await cleanup()
  }
}

function createLibraryMutationFixture(viewportName) {
  const now = new Date('2026-07-04T16:30:00.000Z').toISOString()
  const leadPrefix = `speak-qa-library-mutation-${viewportName}`
  const leads = [
    {
      id: `${leadPrefix}-alpha`,
      firstName: 'Alpha',
      lastName: 'Contact',
      name: 'Alpha Contact',
      company: 'QA Alpha Co',
      phone: '+15555550101',
      email: 'alpha@example.com',
      state: 'NC',
      tags: ['qa'],
      score: 42,
      status: 'ready',
      lastCall: 'Never',
      notes: 'Alpha fixture',
      context: { text: '', urls: [], files: [] },
      source: 'personal-phone',
      sourceId: 'bluebubbles:contacts',
      sourceName: 'Personal Phone Contacts',
    },
    {
      id: `${leadPrefix}-beta`,
      firstName: 'Beta',
      lastName: 'Contact',
      name: 'Beta Contact',
      company: 'QA Beta Co',
      phone: '+15555550102',
      email: 'beta@example.com',
      state: 'SC',
      tags: ['qa'],
      score: 24,
      status: 'ready',
      lastCall: 'Never',
      notes: 'Beta fixture',
      context: { text: '', urls: [], files: [] },
      source: 'personal-phone',
      sourceId: 'bluebubbles:contacts',
      sourceName: 'Personal Phone Contacts',
    },
    {
      id: `${leadPrefix}-calltools`,
      firstName: 'CallTools',
      lastName: 'Contact',
      name: 'CallTools Contact',
      company: 'QA CallTools Co',
      phone: '+15555550103',
      email: 'calltools@example.com',
      state: 'GA',
      tags: ['qa'],
      score: 18,
      status: 'ready',
      lastCall: 'Never',
      notes: 'CallTools fixture',
      context: { text: '', urls: [], files: [] },
      source: 'calltools',
      sourceId: 'campaign:12345:live-filter:70884',
      sourceName: 'CallTools 1.0 Contacts',
    },
  ]
  const personalThreadId = `${leadPrefix}-personal-thread`
  const calltoolsThreadId = `${leadPrefix}-calltools-thread`
  const communicationThreads = [
    {
      threadId: personalThreadId,
      contactId: leads[0].id,
      agentProfileId: 'speak-qa-library-profile',
      channels: ['sms'],
      latestChannel: 'sms',
      latestMessagePreview: 'Personal source activity proof',
      messageCount: 1,
      participants: [
        { role: 'contact', contactId: leads[0].id, label: leads[0].company },
        { role: 'agent', agentProfileId: 'speak-qa-library-profile', label: 'Speak QA Library Agent' },
      ],
      status: 'open',
      updatedAt: now,
    },
    {
      threadId: calltoolsThreadId,
      contactId: leads[2].id,
      agentProfileId: 'speak-qa-library-profile',
      channels: ['call'],
      latestChannel: 'call',
      latestMessagePreview: 'CallTools source activity proof',
      messageCount: 1,
      participants: [
        { role: 'contact', contactId: leads[2].id, label: leads[2].company },
        { role: 'agent', agentProfileId: 'speak-qa-library-profile', label: 'Speak QA Library Agent' },
      ],
      status: 'open',
      updatedAt: now,
    },
  ]
  const communicationMessages = [
    {
      messageId: `${personalThreadId}-message`,
      threadId: personalThreadId,
      channel: 'sms',
      direction: 'inbound',
      role: 'contact',
      speaker: leads[0].company,
      body: 'Personal source activity proof',
      at: now,
    },
    {
      messageId: `${calltoolsThreadId}-message`,
      threadId: calltoolsThreadId,
      channel: 'call',
      direction: 'outbound',
      role: 'agent',
      speaker: 'Speak QA Library Agent',
      body: 'CallTools source activity proof',
      at: now,
    },
  ]
  const fixture = {
    activeProfileId: 'speak-qa-library-profile',
    bulkDeleteRequests: [],
    bulkStatusRequests: [],
    calltoolsThreadId,
    communicationMessages,
    communicationThreads,
    createRequests: [],
    leads,
    patchRequests: [],
    personalThreadId,
    profiles: [
      {
        id: 'speak-qa-library-profile',
        name: 'Speak QA Library Agent',
        updatedAt: now,
        config: {
          voiceRuntimeProvider: 'inworld',
          instructions: '',
        },
        context: { text: '', urls: [], files: [] },
      },
    ],
    smartViews: [],
    now,
  }
  return fixture
}

async function installLibraryMutationFixtureRoutes(page, fixture) {
  const workspacePayload = () => ({
    version: 1,
    updatedAt: fixture.now,
    leads: fixture.leads,
    deletedLeadIds: [],
    deletedLeadFingerprints: [],
    smartViews: fixture.smartViews,
    profiles: fixture.profiles,
    activeProfileId: fixture.activeProfileId,
    communicationThreads: fixture.communicationThreads,
    communicationMessages: fixture.communicationMessages,
    communicationTopics: [],
    contactIdentityLinks: [],
  })
  const fulfillJson = (route, json) => route.fulfill({ json })
  const updateLead = (leadId, patch) => {
    let updatedLead = null
    fixture.leads = fixture.leads.map((lead) => {
      if (lead.id !== leadId) return lead
      updatedLead = {
        ...lead,
        ...patch,
      }
      return updatedLead
    })
    return updatedLead
  }
  const routeHandlers = [
    ['**/api/workspace', (route) => fulfillJson(route, workspacePayload())],
    [
      '**/api/leads**',
      async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        const pathname = url.pathname
        const method = request.method()
        const body = request.postDataJSON?.() || {}

        if (method === 'GET' && /\/api\/leads$/.test(pathname)) {
          return fulfillJson(route, { leads: fixture.leads })
        }
        if (method === 'POST' && /\/api\/leads$/.test(pathname)) {
          const source = String(body.source || '')
          const sourceId = String(body.sourceId || '')
          const sourceName = String(body.sourceName || '')
          fixture.createRequests.push({ source, sourceId, sourceName })
          const createdLead = {
            id: `speak-qa-created-${fixture.createRequests.length}-${source || 'contact'}`,
            firstName: '',
            lastName: '',
            name: '',
            company: 'New contact',
            phone: '',
            email: '',
            state: '',
            tags: [],
            score: 0,
            status: 'ready',
            lastCall: 'Never',
            notes: '',
            context: { text: '', urls: [], files: [] },
            source,
            sourceId,
            sourceName,
          }
          fixture.leads = [createdLead, ...fixture.leads]
          return fulfillJson(route, { lead: createdLead })
        }
        if (method === 'PATCH' && /\/api\/leads\/[^/]+$/.test(pathname)) {
          const leadId = decodeURIComponent(pathname.split('/').at(-1) || '')
          const patch = body.patch || body
          fixture.patchRequests.push({ id: leadId, patch })
          const lead = updateLead(leadId, patch)
          return fulfillJson(route, { lead })
        }
        if (method === 'POST' && pathname.endsWith('/api/leads/bulk-status')) {
          const ids = Array.isArray(body.ids) ? body.ids : []
          const status = body.status
          fixture.bulkStatusRequests.push({ ids, status })
          fixture.leads = fixture.leads.map((lead) =>
            ids.includes(lead.id) ? { ...lead, status } : lead,
          )
          return fulfillJson(route, { leads: fixture.leads })
        }
        if (method === 'POST' && pathname.endsWith('/api/leads/bulk-delete')) {
          const ids = Array.isArray(body.ids) ? body.ids : []
          fixture.bulkDeleteRequests.push({ ids })
          fixture.leads = fixture.leads.filter((lead) => !ids.includes(lead.id))
          return fulfillJson(route, { leads: fixture.leads })
        }
        return fulfillJson(route, { leads: fixture.leads })
      },
    ],
    [
      '**/api/smart-views',
      (route) => fulfillJson(route, { smartViews: fixture.smartViews }),
    ],
    [
      '**/api/calls/recent**',
      (route) => fulfillJson(route, { calls: [] }),
    ],
    [
      '**/api/communication-threads**',
      (route) => {
        const url = new URL(route.request().url())
        const messageThreadId = decodeURIComponent(
          url.pathname.match(/\/api\/communication-threads\/([^/]+)\/messages$/)?.[1] || '',
        )
        if (messageThreadId) {
          return fulfillJson(route, {
            messages: fixture.communicationMessages.filter(
              (message) => message.threadId === messageThreadId,
            ),
          })
        }
        return fulfillJson(route, { threads: fixture.communicationThreads })
      },
    ],
    [
      '**/api/dialer-state',
      (route) => fulfillJson(route, {
        dialerState: {
          sourceId: '',
          activeSmartViewId: '',
          query: '',
          statusFilter: 'all',
          stateFilter: 'all',
          scoreFilter: 'all',
          selectedLeadId: '',
          selectedLeadIds: [],
          campaignQueueIds: [],
          campaignRunning: false,
          scheduledStartAt: '',
          scheduledQueueActive: false,
          updatedAt: fixture.now,
        },
      }),
    ],
  ]

  for (const [pattern, handler] of routeHandlers) {
    await page.route(pattern, handler)
  }

  return async () => {
    for (const [pattern, handler] of routeHandlers) {
      await page.unroute(pattern, handler).catch(() => {})
    }
  }
}

async function collectLibraryMutationFixtureMetrics(page, {
  alphaId,
  betaId,
  calltoolsId,
  updatedCompany,
}) {
  return page.evaluate(({ alphaId: targetAlphaId, betaId: targetBetaId, calltoolsId: targetCalltoolsId, updatedCompany: expectedCompany }) => {
    const isVisible = (node) => {
      if (!node) return false
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      )
    }
    const row = (leadId) =>
      document.querySelector(`.contact-library-row[data-lead-id="${CSS.escape(String(leadId))}"]`)
    const alphaRow = row(targetAlphaId)
    const betaRow = row(targetBetaId)
    const calltoolsRow = row(targetCalltoolsId)
    const betaStatus = betaRow?.querySelector('.contact-library-status select')?.value || ''
    return {
      alphaVisible: isVisible(alphaRow),
      betaVisible: isVisible(betaRow),
      calltoolsVisible: isVisible(calltoolsRow),
      alphaTitle:
        alphaRow?.querySelector('.contact-library-title')?.textContent?.trim() || '',
      betaStatus,
      betaFollowUp: betaStatus === 'follow-up',
      alphaUpdatedVisible:
        alphaRow?.querySelector('.contact-library-title')?.textContent?.trim() === expectedCompany,
      selectedCount: document.querySelectorAll('.contact-library-row.row-selected').length,
      bulkActionsVisible: isVisible(document.querySelector('.bulk-actions')),
    }
  }, { alphaId, betaId, calltoolsId, updatedCompany })
}

async function collectLibraryActivitySourceFixtureMetrics(page, {
  personalThreadId,
  calltoolsThreadId,
}) {
  return page.evaluate(({ personalThreadId: personalId, calltoolsThreadId: calltoolsId }) => {
    const isVisible = (node) => {
      if (!node) return false
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      )
    }
    const row = (threadId) =>
      document.querySelector(`.transcript-library-row[data-thread-id="${CSS.escape(String(threadId))}"]`)
    const rows = Array.from(document.querySelectorAll('.transcript-library-row')).filter(isVisible)
    return {
      activityStatusText:
        document
          .querySelector('.transcript-thread-status')
          ?.textContent?.trim()
          .replace(/\s+/g, ' ') || '',
      calltoolsActivityVisible: isVisible(row(calltoolsId)),
      personalActivityVisible: isVisible(row(personalId)),
      visibleActivityRows: rows.length,
    }
  }, { personalThreadId, calltoolsThreadId })
}

async function waitForUiContractCondition(condition, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

async function verifyAppearanceInteraction({
  failures,
  page,
  routeId,
  summaries,
  viewportName,
}) {
  const beforeUrl = page.url()
  const beforeMetrics = await collectAppearanceMetrics(page)
  summaries.push({
    routeId: `appearance-${routeId}`,
    viewport: viewportName,
    phase: 'before',
    ...beforeMetrics,
  })

  try {
    await page.getByTestId('speak-appearance-trigger').click({ timeout: 3000 })
  } catch (error) {
    failures.push(
      `${viewportName} ${routeId}: appearance trigger did not open (${error instanceof Error ? error.message : String(error)})`,
    )
    return
  }

  await page
    .waitForSelector('.appearance-popover', {
      state: 'visible',
      timeout: 3000,
    })
    .catch(() => {})
  const openMetrics = await collectAppearanceMetrics(page)
  summaries.push({
    routeId: `appearance-${routeId}`,
    viewport: viewportName,
    phase: 'open',
    ...openMetrics,
  })

  if (!openMetrics.popoverVisible) {
    failures.push(`${viewportName} ${routeId}: appearance popover was not visible after opening`)
    return
  }
  for (const option of ['system', 'light', 'dark']) {
    if (!openMetrics.options.includes(option)) {
      failures.push(`${viewportName} ${routeId}: appearance option "${option}" is missing`)
    }
  }
  if (openMetrics.checkedOption !== beforeMetrics.storageAppearance) {
    failures.push(
      `${viewportName} ${routeId}: appearance checked option "${openMetrics.checkedOption}" did not match stored value "${beforeMetrics.storageAppearance}"`,
    )
  }
  if (openMetrics.overflowX > 0) {
    failures.push(
      `${viewportName} ${routeId}: appearance popover overflows viewport horizontally by ${openMetrics.overflowX}px`,
    )
  }

  const original = beforeMetrics.storageAppearance || 'system'
  const target = original === 'dark' ? 'light' : 'dark'
  await page
    .locator(`[data-action-id="select_appearance_${target}"]`)
    .click({ noWaitAfter: true, timeout: 3000 })
    .catch((error) => {
      failures.push(
        `${viewportName} ${routeId}: could not select ${target} appearance (${error instanceof Error ? error.message : String(error)})`,
      )
    })
  await page
    .waitForFunction(
      (appearance) =>
        document.documentElement.dataset.appearance === appearance &&
        window.localStorage.getItem('speak:appearance') === appearance &&
        !document.querySelector('.appearance-popover'),
      target,
      { timeout: 3000 },
    )
    .catch(() => {})

  const selectedMetrics = await collectAppearanceMetrics(page)
  summaries.push({
    routeId: `appearance-${routeId}`,
    viewport: viewportName,
    phase: 'selected',
    target,
    ...selectedMetrics,
  })
  if (selectedMetrics.datasetAppearance !== target) {
    failures.push(
      `${viewportName} ${routeId}: selecting ${target} did not update document appearance`,
    )
  }
  if (selectedMetrics.storageAppearance !== target) {
    failures.push(
      `${viewportName} ${routeId}: selecting ${target} did not persist to localStorage`,
    )
  }
  if (selectedMetrics.popoverVisible) {
    failures.push(`${viewportName} ${routeId}: appearance popover did not close after selection`)
  }
  if (!selectedMetrics.triggerLabel?.toLowerCase().includes(target)) {
    failures.push(
      `${viewportName} ${routeId}: appearance trigger label did not update after selecting ${target}`,
    )
  }

  await page
    .getByTestId('speak-appearance-trigger')
    .click({ noWaitAfter: true, timeout: 3000 })
    .catch(() => {})
  await page
    .locator(`[data-action-id="select_appearance_${original}"]`)
    .click({ noWaitAfter: true, timeout: 3000 })
    .catch((error) => {
      failures.push(
        `${viewportName} ${routeId}: could not restore ${original} appearance (${error instanceof Error ? error.message : String(error)})`,
      )
    })
  await page
    .waitForFunction(
      (appearance) =>
        document.documentElement.dataset.appearance === appearance &&
        window.localStorage.getItem('speak:appearance') === appearance,
      original,
      { timeout: 3000 },
    )
    .catch(() => {})

  const restoredMetrics = await collectAppearanceMetrics(page)
  summaries.push({
    routeId: `appearance-${routeId}`,
    viewport: viewportName,
    phase: 'restored',
    original,
    ...restoredMetrics,
  })
  if (restoredMetrics.datasetAppearance !== original) {
    failures.push(
      `${viewportName} ${routeId}: appearance restore left document at "${restoredMetrics.datasetAppearance}" instead of "${original}"`,
    )
  }
  if (restoredMetrics.storageAppearance !== original) {
    failures.push(
      `${viewportName} ${routeId}: appearance restore left storage at "${restoredMetrics.storageAppearance}" instead of "${original}"`,
    )
  }
  if (restoredMetrics.popoverVisible) {
    failures.push(`${viewportName} ${routeId}: appearance popover stayed open after restore`)
  }
  if (page.url() !== beforeUrl) {
    failures.push(`${viewportName} ${routeId}: appearance interaction changed URL unexpectedly`)
  }
}

async function collectAppearanceMetrics(page) {
  return page.evaluate(() => {
    const isVisible = (node) => {
      if (!node) return false
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      )
    }
    const trigger = document.querySelector('[data-testid="speak-appearance-trigger"]')
    const popover = document.querySelector('.appearance-popover')
    const optionNodes = Array.from(
      popover?.querySelectorAll('[data-action-id^="select_appearance_"]') || [],
    ).filter(isVisible)
    const popoverRect = popover?.getBoundingClientRect()
    const overflowX = popoverRect
      ? Math.max(0, -popoverRect.left, popoverRect.right - window.innerWidth)
      : 0

    return {
      datasetAppearance: document.documentElement.dataset.appearance || '',
      storageAppearance: window.localStorage.getItem('speak:appearance') || '',
      triggerVisible: isVisible(trigger),
      triggerLabel: trigger?.getAttribute('aria-label') || trigger?.getAttribute('title') || '',
      triggerExpanded: trigger?.getAttribute('aria-expanded') || '',
      popoverVisible: isVisible(popover),
      options: optionNodes
        .map((node) =>
          (node.getAttribute('data-action-id') || '').replace(/^select_appearance_/, ''),
        )
        .filter(Boolean),
      checkedOption:
        optionNodes
          .find((node) => node.getAttribute('aria-checked') === 'true')
          ?.getAttribute('data-action-id')
          ?.replace(/^select_appearance_/, '') || '',
      overflowX: Math.round(overflowX),
    }
  })
}

async function verifyDialerSetupInteraction({
  failures,
  page,
  summaries,
  viewportName,
}) {
  const beforeUrl = page.url()
  const beforeMetrics = await collectDialerSetupMetrics(page)
  summaries.push({
    routeId: 'dialer-setup',
    viewport: viewportName,
    phase: 'before',
    ...beforeMetrics,
  })

  try {
    await page.locator('.dialer-topbar .dialer-setup-trigger').click({ timeout: 3000 })
  } catch (error) {
    failures.push(
      `${viewportName} dialer setup: trigger did not open (${error instanceof Error ? error.message : String(error)})`,
    )
    return
  }

  await page
    .waitForSelector('.dialer-schedule-popover[role="dialog"]', {
      state: 'visible',
      timeout: 3000,
    })
    .catch(() => {})

  const openMetrics = await collectDialerSetupMetrics(page)
  summaries.push({
    routeId: 'dialer-setup',
    viewport: viewportName,
    phase: 'open',
    ...openMetrics,
  })

  if (!openMetrics.popoverVisible) {
    failures.push(`${viewportName} dialer setup: popover was not visible after opening`)
    return
  }
  if (openMetrics.popoverRole !== 'dialog' || openMetrics.popoverLabel !== 'Dialer setup') {
    failures.push(`${viewportName} dialer setup: popover is missing dialog semantics`)
  }
  if (openMetrics.triggerExpanded !== 'true') {
    failures.push(`${viewportName} dialer setup: trigger aria-expanded did not become true`)
  }
  for (const label of ['Agent', 'Contact list', 'Schedule']) {
    if (!openMetrics.labels.includes(label)) {
      failures.push(`${viewportName} dialer setup: missing ${label} control label`)
    }
  }
  if (!openMetrics.agentSelectVisible || openMetrics.agentOptionCount < 1) {
    failures.push(`${viewportName} dialer setup: agent select is missing usable options`)
  }
  if (!openMetrics.sourceSelectVisible || openMetrics.sourceOptionCount < 2) {
    failures.push(`${viewportName} dialer setup: contact-list select is missing base options`)
  }
  if (!openMetrics.scheduleInputVisible || openMetrics.scheduleInputType !== 'datetime-local') {
    failures.push(`${viewportName} dialer setup: schedule datetime input is missing`)
  }
  if (!openMetrics.clearScheduleVisible) {
    failures.push(`${viewportName} dialer setup: schedule clear action is missing`)
  }
  if (!openMetrics.summaryVisible || !openMetrics.summaryText) {
    failures.push(`${viewportName} dialer setup: setup summary is missing`)
  }
  if (openMetrics.overflowX > 0) {
    failures.push(
      `${viewportName} dialer setup: popover overflows viewport horizontally by ${openMetrics.overflowX}px`,
    )
  }
  if (openMetrics.triggerLabel && openMetrics.summaryText) {
    const normalizedTrigger = openMetrics.triggerLabel.toLowerCase()
    const normalizedSummary = openMetrics.summaryText.toLowerCase()
    const sourceToken = openMetrics.activeSourceName.toLowerCase()
    if (sourceToken && !normalizedTrigger.includes(sourceToken)) {
      failures.push(`${viewportName} dialer setup: trigger label does not include active source`)
    }
    if (sourceToken && !normalizedSummary.includes(sourceToken)) {
      failures.push(`${viewportName} dialer setup: summary does not include active source`)
    }
  }

  await page.keyboard.press('Escape')
  await page
    .waitForFunction(
      () =>
        !document.querySelector('.dialer-schedule-popover') &&
        document
          .querySelector('.dialer-topbar .dialer-setup-trigger')
          ?.getAttribute('aria-expanded') === 'false',
      null,
      { timeout: 3000 },
    )
    .catch(() => {})

  const closedMetrics = await collectDialerSetupMetrics(page)
  summaries.push({
    routeId: 'dialer-setup',
    viewport: viewportName,
    phase: 'closed',
    ...closedMetrics,
  })
  if (closedMetrics.popoverVisible) {
    failures.push(`${viewportName} dialer setup: popover did not close on Escape`)
  }
  if (closedMetrics.triggerExpanded !== 'false') {
    failures.push(`${viewportName} dialer setup: trigger aria-expanded did not reset after Escape`)
  }
  if (page.url() !== beforeUrl) {
    failures.push(`${viewportName} dialer setup: interaction changed URL unexpectedly`)
  }
}

async function collectDialerSetupMetrics(page) {
  return page.evaluate(() => {
    const isVisible = (node) => {
      if (!node) return false
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      )
    }
    const trigger = document.querySelector('.dialer-topbar .dialer-setup-trigger')
    const popover = document.querySelector('.dialer-schedule-popover')
    const agentSelect = popover?.querySelector('[data-action-id="select_agent_profile"]')
    const sourceSelect = popover?.querySelector('[data-action-id="select_contact_source"]')
    const scheduleInput = popover?.querySelector('input[type="datetime-local"]')
    const clearScheduleButton = popover?.querySelector('[aria-label="Clear scheduled time"]')
    const summary = popover?.querySelector('.dialer-setup-summary')
    const popoverRect = popover?.getBoundingClientRect()
    const overflowX = popoverRect
      ? Math.max(0, -popoverRect.left, popoverRect.right - window.innerWidth)
      : 0
    const labels = Array.from(popover?.querySelectorAll('label > span') || [])
      .map((node) => node.textContent?.trim() || '')
      .filter(Boolean)
    const activeSourceName =
      trigger?.querySelector('.dialer-setup-copy strong')?.textContent?.trim() ||
      (trigger?.getAttribute('aria-label') || '').replace(/^Dialer setup:\s*/i, '').split(',')[0]?.trim() ||
      ''

    return {
      triggerVisible: isVisible(trigger),
      triggerExpanded: trigger?.getAttribute('aria-expanded') || '',
      triggerLabel: trigger?.getAttribute('aria-label') || trigger?.getAttribute('title') || '',
      activeSourceName,
      popoverVisible: isVisible(popover),
      popoverRole: popover?.getAttribute('role') || '',
      popoverLabel: popover?.getAttribute('aria-label') || '',
      labels,
      agentSelectVisible: isVisible(agentSelect),
      agentOptionCount: agentSelect?.querySelectorAll('option').length || 0,
      sourceSelectVisible: isVisible(sourceSelect),
      sourceOptionCount: sourceSelect?.querySelectorAll('option').length || 0,
      scheduleInputVisible: isVisible(scheduleInput),
      scheduleInputType: scheduleInput?.getAttribute('type') || '',
      clearScheduleVisible: isVisible(clearScheduleButton),
      summaryVisible: isVisible(summary),
      summaryText: summary?.textContent?.replace(/\s+/g, ' ').trim() || '',
      overflowX: Math.round(overflowX),
    }
  })
}

async function verifyPlaygroundProfileSelectionIsolation({
  baseUrl,
  failures,
  page,
  summaries,
}) {
  const now = '2026-07-14T22:00:00.000Z'
  const activeProfileId = 'speak-qa-global-dialer-profile'
  const editorProfileId = 'speak-qa-editor-only-profile'
  const profileFixture = {
    activeProfileId,
    profiles: [
      {
        id: activeProfileId,
        name: 'Speak QA Global Dialer Agent',
        updatedAt: now,
        config: { instructions: 'Global Dialer profile.' },
        testVariables: {},
      },
      {
        id: editorProfileId,
        name: 'Speak QA Editor Only Agent',
        updatedAt: '2026-07-14T22:01:00.000Z',
        config: { instructions: 'Editor-only profile.' },
        testVariables: {},
      },
    ],
  }
  const profileWrites = []
  const profileRoutePattern = /\/api\/profiles$/
  const profileRouteHandler = async (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(profileFixture),
      })
      return
    }
    if (request.method() === 'PUT') {
      profileWrites.push(request.postDataJSON())
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(profileFixture),
      })
      return
    }
    await route.continue()
  }

  await page.route(profileRoutePattern, profileRouteHandler)
  try {
    await page.setViewportSize({ width: 1378, height: 790 })
    await page.goto(`${baseUrl}/configs`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})

    const editorRow = page
      .locator('.config-profile-row')
      .filter({ hasText: 'Speak QA Editor Only Agent' })
    if ((await editorRow.count()) !== 1) {
      failures.push('Playground profile isolation browser contract: editor profile row is missing')
      return
    }
    await editorRow.evaluate((node) => node.click())
    await page.waitForTimeout(150)
    const clickSelected = (await editorRow.getAttribute('aria-selected')) === 'true'
    const clickWriteCount = profileWrites.length
    if (!clickSelected) {
      failures.push('Playground profile isolation browser contract: clicking a profile did not select it in the editor')
    }
    if (clickWriteCount > 0) {
      failures.push('Playground profile isolation browser contract: editor selection changed the global active profile')
    }

    profileWrites.length = 0
    await page.goto(`${baseUrl}/configs#profile=${editorProfileId}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
    const deepLinkedRow = page
      .locator('.config-profile-row')
      .filter({ hasText: 'Speak QA Editor Only Agent' })
    await deepLinkedRow
      .waitFor({ state: 'visible', timeout: 3000 })
      .catch(() => {})
    await page.waitForTimeout(150)
    const deepLinkSelected =
      (await deepLinkedRow.getAttribute('aria-selected')) === 'true'
    const deepLinkWriteCount = profileWrites.length
    if (!deepLinkSelected) {
      failures.push('Playground profile isolation browser contract: profile deep link did not select the editor profile')
    }
    if (deepLinkWriteCount > 0) {
      failures.push('Playground profile isolation browser contract: profile deep link changed the global active profile')
    }

    summaries.push({
      routeId: 'playground-profile-isolation',
      viewport: 'desktop',
      clickSelected,
      clickWriteCount,
      deepLinkSelected,
      deepLinkWriteCount,
    })
  } finally {
    await page.unroute(profileRoutePattern, profileRouteHandler)
  }
}

async function verifyPlaygroundCallMethods({
  baseUrl,
  browser,
  failures,
  summaries,
}) {
  const page = await browser.newPage({ viewport: { width: 1378, height: 790 } })
  const now = '2026-07-15T20:00:00.000Z'
  const lead = {
    id: 'speak-qa-playground-contact',
    firstName: 'Taylor',
    lastName: 'Fixture',
    name: 'Taylor Fixture',
    company: 'Playground QA',
    phone: '+12125550199',
    email: 'taylor@example.test',
    status: 'ready',
    state: 'NY',
    tags: ['qa'],
    score: 100,
    lastCall: 'Never',
    notes: 'Isolated Playground fixture',
  }
  const phoneNumbers = [
    {
      id: 'qa-number-one',
      label: 'QA Main / +12125550101',
      phoneNumber: '+12125550101',
      connectionId: 'qa-workspace-call-control',
      source: 'telnyx',
      isDefault: true,
    },
    {
      id: 'qa-number-two',
      label: 'QA Alternate / +12125550102',
      phoneNumber: '+12125550102',
      connectionId: 'qa-workspace-call-control',
      source: 'telnyx',
    },
  ]
  const humeProfile = {
    id: 'speak-qa-hume-codex-profile',
    name: 'Hume Codex QA',
    updatedAt: now,
    config: {
      agentProfileId: 'speak-qa-hume-codex-profile',
      agentProfileName: 'Hume Codex QA',
      calltoolsAgentBinding: {
        enabled: true,
        mode: 'phone_as_agent',
        appUserId: 'qa-shared-seat',
        campaignId: 'qa-campaign',
        phoneId: 'qa-calltools-phone',
      },
      codexAuthModel: 'gpt-5.4',
      dialerProvider: 'calltools',
      humeConfigId: 'qa-hume-config',
      instructions: 'Handle the fixture naturally.',
      languageModelMode: 'codex',
      sampleRate: 16000,
      telnyxCallerId: phoneNumbers[0].phoneNumber,
      telnyxConnectionId: phoneNumbers[0].connectionId,
      voiceRuntimeProvider: 'hume',
    },
    testVariables: {},
  }
  const inworldProfile = {
    id: 'speak-qa-inworld-native-profile',
    name: 'Inworld Native QA',
    updatedAt: '2026-07-15T19:59:00.000Z',
    config: {
      agentProfileId: 'speak-qa-inworld-native-profile',
      agentProfileName: 'Inworld Native QA',
      calltoolsAgentBinding: {
        enabled: true,
        mode: 'phone_as_agent',
        appUserId: 'qa-shared-seat',
        campaignId: 'qa-campaign',
        phoneId: 'qa-calltools-phone',
      },
      dialerProvider: 'calltools',
      inworldConfigId: 'qa-inworld-config',
      inworldLanguageModel: 'INWORLD:inworld-llm',
      instructions: 'Handle the fixture naturally.',
      languageModelMode: 'inworld',
      sampleRate: 16000,
      telnyxCallerId: phoneNumbers[0].phoneNumber,
      telnyxConnectionId: phoneNumbers[0].connectionId,
      voiceRuntimeProvider: 'inworld',
    },
    testVariables: {},
  }
  const xaiProfile = {
    id: 'speak-qa-xai-native-profile',
    name: 'xAI Native QA',
    updatedAt: '2026-07-15T19:58:00.000Z',
    config: {
      agentProfileId: 'speak-qa-xai-native-profile',
      agentProfileName: 'xAI Native QA',
      calltoolsAgentBinding: {
        enabled: true,
        mode: 'phone_as_agent',
        appUserId: 'qa-shared-seat',
        campaignId: 'qa-campaign',
        phoneId: 'qa-calltools-phone',
      },
      dialerProvider: 'calltools',
      instructions: 'Handle the fixture naturally.',
      languageModelMode: 'xai',
      languageModelProvider: 'XAI_VOICE',
      sampleRate: 16000,
      telnyxCallerId: phoneNumbers[0].phoneNumber,
      telnyxConnectionId: phoneNumbers[0].connectionId,
      voice: 'eve',
      voiceRuntimeProvider: 'xai',
      xaiConfigId: 'xai-realtime',
      xaiOutputSampleRate: 16000,
      xaiRealtimeModel: 'grok-voice-latest',
      xaiVoiceId: 'eve',
      xaiVoiceName: 'Eve',
      xaiVoiceProvider: 'XAI_BUILTIN',
    },
    testVariables: {},
  }
  let profiles = [humeProfile, inworldProfile, xaiProfile]
  let activeProfileId = humeProfile.id
  let phoneProviderConfigured = false
  const browserStarts = []
  const callStarts = []
  const browserEnds = []
  const phoneEnds = []
  const phoneInstructions = []
  const profileWrites = []
  const providerSyncs = []
  const calltoolsRequests = []
  const localConsoleEntries = []

  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      localConsoleEntries.push(`${message.type()}:${message.text()}`)
    }
  })
  await page.addInitScript(() => {
    localStorage.clear()
    const eventSources = new Map()
    const eventSourceLifecycle = []
    const supervisionSockets = []
    globalThis.__speakQaSessionEventSourceState = () => ({
      active: [...eventSources.keys()],
      lifecycle: [...eventSourceLifecycle],
    })
    globalThis.__speakQaHasSessionEventSource = (id) => {
      const source = eventSources.get(String(id))
      return Boolean(source && !source.closed)
    }
    globalThis.__speakQaEmitSessionEvent = (id, payload) => {
      const source = eventSources.get(String(id))
      if (!source || source.closed) return false
      source.onmessage?.({ data: JSON.stringify(payload) })
      return true
    }
    globalThis.__speakQaSupervisionState = () =>
      supervisionSockets.map((socket) => ({
        sent: [...socket.sent],
        url: socket.url,
      }))
    globalThis.EventSource = class {
      constructor(url) {
        this.url = String(url)
        this.closed = false
        const match = this.url.match(/\/calls\/([^/]+)\/events/)
        this.sessionId = decodeURIComponent(match?.[1] || '')
        eventSources.set(this.sessionId, this)
        eventSourceLifecycle.push({ action: 'open', id: this.sessionId, url: this.url })
        setTimeout(() => this.onopen?.({}), 0)
      }

      close() {
        this.closed = true
        eventSources.delete(this.sessionId)
        eventSourceLifecycle.push({ action: 'close', id: this.sessionId, url: this.url })
      }
    }
    globalThis.WebSocket = class {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      constructor(url) {
        this.url = String(url)
        this.readyState = 0
        this.sent = []
        if (/\/supervision(?:\?|$)/.test(this.url)) supervisionSockets.push(this)
        setTimeout(() => {
          this.readyState = 1
          this.onopen?.({})
          if (/\/supervision(?:\?|$)/.test(this.url)) {
            this.onmessage?.({
              data: JSON.stringify({
                type: 'ready',
                audioWhisperAvailable: true,
                maxWhisperMs: 30000,
                spyAvailable: true,
              }),
            })
          }
        }, 0)
      }

      close() {
        this.readyState = 3
        this.onclose?.({})
      }

      send(value) {
        this.sent.push(value)
        if (typeof value !== 'string') return
        const message = JSON.parse(value)
        if (message.type === 'monitor.set') {
          setTimeout(() => this.onmessage?.({
            data: JSON.stringify({
              type: 'monitor.updated',
              enabled: Boolean(message.enabled),
            }),
          }), 0)
        }
      }
    }
    const silentNode = () => ({
      connect() {},
      disconnect() {},
    })
    globalThis.AudioContext = class {
      constructor() {
        this.currentTime = 0
        this.destination = {}
        this.sampleRate = 48000
        this.state = 'running'
      }

      close() { return Promise.resolve() }
      resume() {
        this.state = 'running'
        return Promise.resolve()
      }
      createMediaStreamSource() { return silentNode() }
      createScriptProcessor() { return { ...silentNode(), onaudioprocess: null } }
      createBuffer() {
        return { duration: 0, getChannelData: () => new Float32Array(0) }
      }
      createBufferSource() {
        return { ...silentNode(), buffer: null, onended: null, start() {} }
      }
    }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop() {} }],
        }),
      },
    })
  })

  const apiHandler = async (route) => {
    const request = route.request()
    const method = request.method()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/speak\/api/, '/api')
    const json = (body, status = 200) =>
      route.fulfill({
        body: JSON.stringify(body),
        contentType: 'application/json',
        status,
      })

    if (path === '/api/profiles') {
      if (method === 'PUT') {
        const payload = request.postDataJSON()
        profileWrites.push(payload)
        profiles = payload.profiles || profiles
        activeProfileId = payload.activeProfileId || activeProfileId
      }
      await json({ activeProfileId, profiles })
      return
    }
    if (path === '/api/health') {
      await json({
        ok: true,
        defaults: {
          sampleRate: 16000,
          telnyxCallerId: phoneNumbers[0].phoneNumber,
          telnyxConnectionId: phoneNumbers[0].connectionId,
        },
      })
      return
    }
    if (path === '/api/agent-configs/speak-options') {
      await json({
        codexAuthModels: [],
        eviVersions: [],
        functionTools: [],
        languageModels: [],
        voices: [],
      })
      return
    }
    if (path === '/api/agent-configs/sync-speak' && method === 'POST') {
      const payload = request.postDataJSON()
      providerSyncs.push(payload)
      const inworld = payload.config?.voiceRuntimeProvider === 'inworld'
      await json({
        action: 'updated',
        config: payload.config,
        inworldConfigId: inworld ? 'qa-inworld-config' : undefined,
        speakConfigId: inworld ? 'qa-inworld-config' : 'qa-hume-config',
        humeConfigId: inworld ? undefined : 'qa-hume-config',
      })
      return
    }
    if (path === '/api/smart-views') {
      await json({ smartViews: [] })
      return
    }
    if (path === '/api/leads') {
      await json({ leads: [lead], matchedCount: 1, total: 1 })
      return
    }
    if (path === '/api/contact-sources') {
      await json({ sources: [] })
      return
    }
    if (path === '/api/config-tests/recent') {
      await json({ tests: [] })
      return
    }
    if (path === '/api/communication-threads') {
      await json({ threads: [] })
      return
    }
    if (path === '/api/phone-provider/options') {
      await json({
        configured: phoneProviderConfigured,
        defaultNumber: phoneProviderConfigured ? phoneNumbers[0] : null,
        numbers: phoneProviderConfigured ? phoneNumbers : [],
        proof: { source: 'isolated-playground-fixture' },
      })
      return
    }
    if (path === '/api/config-tests/start' && method === 'POST') {
      const payload = request.postDataJSON()
      browserStarts.push(payload)
      await json({ testId: `qa-browser-${browserStarts.length}` }, 201)
      return
    }
    if (/^\/api\/config-tests\/[^/]+\/end$/.test(path) && method === 'POST') {
      browserEnds.push(path.split('/').at(-2))
      await json({ ok: true })
      return
    }
    if (/^\/api\/config-tests\/[^/]+\/message$/.test(path) && method === 'POST') {
      await json({ ok: true })
      return
    }
    if (path === '/api/calls/start' && method === 'POST') {
      const payload = request.postDataJSON()
      callStarts.push(payload)
      await json({
        callControlId: `qa-phone-${callStarts.length}`,
        chatId: null,
        playgroundSupervisionToken: `qa-supervision-${callStarts.length}`,
        streamId: null,
      }, 202)
      return
    }
    if (/^\/api\/calls\/[^/]+\/end$/.test(path) && method === 'POST') {
      phoneEnds.push({ id: path.split('/').at(-2), payload: request.postDataJSON() })
      await json({ ok: true })
      return
    }
    if (/^\/api\/calls\/[^/]+\/instructions$/.test(path) && method === 'POST') {
      phoneInstructions.push({
        id: path.split('/').at(-2),
        payload: request.postDataJSON(),
      })
      await json({ ok: true })
      return
    }
    if (path.startsWith('/api/calltools/')) {
      calltoolsRequests.push({ method, path })
      await json({ error: 'CallTools is outside the Playground fixture' }, 418)
      return
    }
    await json({})
  }

  await page.route('**/api/**', apiHandler)
  try {
    await page.goto(`${baseUrl}/configs`, { waitUntil: 'domcontentloaded' })
    await page
      .locator('[data-testid="speak-config-test-panel"]')
      .waitFor({ state: 'visible', timeout: 6000 })

    const callToggle = page.locator('[data-testid="speak-config-test-toggle"]')
    await callToggle.click()
    const browserOption = page.getByRole('menuitem', { name: 'Browser' })
    const phoneOption = page.getByRole('menuitem', { name: /Phone test\./ })
    const deviceLink = page.getByRole('link', { name: /from this device/i })
    await page
      .getByText('No Speak/Telnyx outbound number is available.', { exact: true })
      .waitFor({ state: 'visible', timeout: 3000 })

    const blockedMetrics = {
      browserEnabled: await browserOption.isEnabled(),
      deviceActionId: await deviceLink.getAttribute('data-action-id'),
      deviceHref: await deviceLink.getAttribute('href'),
      phoneEnabled: await phoneOption.isEnabled(),
    }
    if (!blockedMetrics.browserEnabled) {
      failures.push('Playground call-method browser fixture: Browser was blocked by phone-provider readiness')
    }
    if (blockedMetrics.phoneEnabled) {
      failures.push('Playground call-method phone fixture: Phone remained enabled without a Speak/Telnyx number')
    }
    if (blockedMetrics.deviceActionId !== 'call_lead_from_device') {
      failures.push('Playground call-method device fixture: Device did not expose the local handoff action id')
    }
    if (blockedMetrics.deviceHref !== 'tel:+12125550199') {
      failures.push(`Playground call-method device fixture: expected tel:+12125550199, got ${blockedMetrics.deviceHref}`)
    }

    await browserOption.click()
    await waitForUiContractCondition(() => browserStarts.length === 1)
    const browserId = 'qa-browser-1'
    await page
      .locator('.call-attempt.live-attempt')
      .waitFor({ state: 'visible', timeout: 5000 })
    const browserLiveBeforeTurn = await page.locator('.call-attempt.live-attempt').isVisible()
    const browserWaitingBeforeTurn = await page
      .locator('.call-attempt.live-attempt')
      .getByText('Waiting for test turns.', { exact: true })
      .isVisible()
    if (await page.locator('[data-testid="speak-playground-phone-supervision"]').count()) {
      failures.push('Playground call-method browser fixture exposed Phone supervision controls')
    }
    try {
      await page.waitForFunction(
        (id) => globalThis.__speakQaHasSessionEventSource?.(id) === true,
        browserId,
        { timeout: 10000 },
      )
    } catch (error) {
      const state = await page.evaluate(() => ({
        eventSources: globalThis.__speakQaSessionEventSourceState?.() || null,
        text: document.body.innerText.slice(0, 1200),
      }))
      throw new Error(
        `Browser fixture response stream timeout (${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify(state)}; ends=${JSON.stringify(browserEnds)})`,
      )
    }
    const browserEventEmitted = await page.evaluate(
      ({ id, payload }) => globalThis.__speakQaEmitSessionEvent?.(id, payload) === true,
      {
        id: browserId,
        payload: {
          entry: {
            at: '4:00:01 PM',
            speaker: 'AI',
            text: 'Browser fixture response',
            tone: 'neutral',
          },
          notice: 'Browser fixture live',
        },
      },
    )
    if (!browserEventEmitted) {
      throw new Error('Browser fixture session event stream detached before transcript emission')
    }
    await page
      .getByText('Browser fixture response', { exact: true })
      .waitFor({ state: 'visible', timeout: 3000 })
    await callToggle.click()
    await waitForUiContractCondition(() => browserEnds.includes(browserId))

    phoneProviderConfigured = true
    await callToggle.click()
    const outboundSelect = page.getByLabel('Speak/Telnyx phone-test caller ID')
    await outboundSelect.locator('option').nth(1).waitFor({ state: 'attached', timeout: 3000 })

    for (const [index, option] of phoneNumbers.entries()) {
      await outboundSelect.selectOption(option.phoneNumber)
      await page.getByRole('menuitem', { name: /Phone test\./ }).click()
      const expectedCount = index + 1
      await waitForUiContractCondition(() => callStarts.length === expectedCount)
      const callId = `qa-phone-${expectedCount}`
      const liveAttempt = page.locator('.call-attempt.live-attempt')
      await liveAttempt.waitFor({ state: 'visible', timeout: 5000 })
      const liveBeforeTurn = await liveAttempt.isVisible()
      const waitingBeforeTurn = await liveAttempt
        .getByText('Waiting for test turns.', { exact: true })
        .isVisible()
      if (!liveBeforeTurn || !waitingBeforeTurn) {
        failures.push(`Playground call-method phone fixture: ${option.phoneNumber} did not render an immediate live transcript attempt`)
      }
      await page.waitForFunction(
        (id) => globalThis.__speakQaHasSessionEventSource?.(id) === true,
        callId,
        { timeout: 10000 },
      )
      const phoneEventEmitted = await page.evaluate(
        ({ callId, index }) => globalThis.__speakQaEmitSessionEvent?.(callId, {
          entry: {
            at: `4:01:0${index} PM`,
            speaker: 'Lead',
            text: `Phone fixture caller ${index + 1}`,
            tone: 'neutral',
          },
          notice: 'Phone fixture live',
          patch: {
            chatId: `qa-chat-${index + 1}`,
            phase: 'live',
            streamId: `qa-stream-${index + 1}`,
          },
        }) === true,
        { callId, index },
      )
      if (!phoneEventEmitted) {
        throw new Error(`Phone fixture ${callId} event stream detached before transcript emission`)
      }
      await page
        .getByText(`Phone fixture caller ${index + 1}`, { exact: true })
        .waitFor({ state: 'visible', timeout: 3000 })

      if (index === 0) {
        const supervisionControls = page.getByTestId('speak-playground-phone-supervision')
        await supervisionControls.waitFor({ state: 'visible', timeout: 3000 })
        const spyControl = page.locator('[data-action-id="toggle_playground_spy"]')
        const bargeControl = page.locator('[data-action-id="toggle_playground_barge"]')
        const audioWhisperControl = page.locator(
          '[data-action-id="toggle_playground_audio_whisper"]',
        )
        const supervisionReady =
          (await spyControl.isVisible()) &&
          (await bargeControl.isVisible()) &&
          (await audioWhisperControl.isVisible()) &&
          (await spyControl.isEnabled()) &&
          (await bargeControl.isEnabled()) &&
          (await audioWhisperControl.isEnabled())
        if (
          !supervisionReady
        ) {
          failures.push('Playground call-method phone fixture did not expose ready Spy, Barge, and audio Whisper controls')
        }
        if (supervisionReady) {
          await spyControl.click()
          await page.waitForFunction(() =>
            document
              .querySelector('[data-action-id="toggle_playground_spy"]')
              ?.getAttribute('aria-pressed') === 'true',
          )
        }
        const composer = page.locator('.playground-composer textarea')
        const phonePlaceholder = await composer.getAttribute('placeholder')
        if (!/Whisper to Hume Codex QA privately/.test(phonePlaceholder || '')) {
          failures.push(`Playground call-method phone fixture did not label the composer as private Whisper (${phonePlaceholder})`)
        }
        await composer.fill('Keep the phone conversation moving')
        await page
          .getByRole('button', { name: 'Send private text whisper to agent' })
          .click()
        await waitForUiContractCondition(() => phoneInstructions.length === 1)
        if (browserStarts.length !== 1) {
          failures.push('Playground call-method phone fixture: Phone composer started a second Browser session')
        }
      }

      await callToggle.click()
      await waitForUiContractCondition(() => phoneEnds.length === expectedCount)
      if (index < phoneNumbers.length - 1) {
        await callToggle.click()
        await page
          .getByLabel('Speak/Telnyx phone-test caller ID')
          .locator('option')
          .nth(1)
          .waitFor({ state: 'attached', timeout: 3000 })
      }
    }

    const inworldRow = page
      .locator('.config-profile-row')
      .filter({ hasText: inworldProfile.name })
    await page.waitForFunction(
      (profileName) => {
        const row = Array.from(document.querySelectorAll('.config-profile-row'))
          .find((node) => node.textContent?.includes(profileName))
        return row?.getAttribute('aria-disabled') === 'false'
      },
      inworldProfile.name,
      { timeout: 5000 },
    )
    await inworldRow.evaluate((node) => node.click())
    await page.waitForFunction(
      (profileName) => {
        const row = Array.from(document.querySelectorAll('.config-profile-row'))
          .find((node) => node.textContent?.includes(profileName))
        return row?.getAttribute('aria-selected') === 'true'
      },
      inworldProfile.name,
      { timeout: 5000 },
    )
    await callToggle.click()
    await page
      .getByLabel('Speak/Telnyx phone-test caller ID')
      .selectOption(phoneNumbers[0].phoneNumber)
    await page.getByRole('menuitem', { name: /Phone test\./ }).click()
    await waitForUiContractCondition(() => callStarts.length === 3)
    await callToggle.click()
    await waitForUiContractCondition(() => phoneEnds.length === 3)

    const xaiRow = page
      .locator('.config-profile-row')
      .filter({ hasText: xaiProfile.name })
    await page.waitForFunction(
      (profileName) => {
        const row = Array.from(document.querySelectorAll('.config-profile-row'))
          .find((node) => node.textContent?.includes(profileName))
        return row?.getAttribute('aria-disabled') === 'false'
      },
      xaiProfile.name,
      { timeout: 5000 },
    )
    await xaiRow.evaluate((node) => node.click())
    await page.waitForFunction(
      (profileName) => {
        const row = Array.from(document.querySelectorAll('.config-profile-row'))
          .find((node) => node.textContent?.includes(profileName))
        return row?.getAttribute('aria-selected') === 'true'
      },
      xaiProfile.name,
      { timeout: 5000 },
    )
    await callToggle.click()
    await page
      .getByLabel('Speak/Telnyx phone-test caller ID')
      .selectOption(phoneNumbers[0].phoneNumber)
    await page.getByRole('menuitem', { name: /Phone test\./ }).click()
    await waitForUiContractCondition(() => callStarts.length === 4)
    await callToggle.click()
    await waitForUiContractCondition(() => phoneEnds.length === 4)

    const humeCalls = callStarts.slice(0, 2)
    const inworldCall = callStarts[2]
    const xaiCall = callStarts[3]
    const calledNumbers = new Set(humeCalls.map((item) => item.config?.telnyxCallerId))
    for (const option of phoneNumbers) {
      if (!calledNumbers.has(option.phoneNumber)) {
        failures.push(`Playground call-method phone fixture: ${option.phoneNumber} was not usable for outbound Phone testing`)
      }
    }
    callStarts.forEach((item, index) => {
      if (item.config?.dialerProvider !== 'speak') {
        failures.push(`Playground call-method phone fixture: call ${index + 1} did not force Speak/Telnyx transport`)
      }
      if (item.config?.telnyxConnectionId !== 'qa-workspace-call-control') {
        failures.push(`Playground call-method phone fixture: call ${index + 1} did not use the workspace Call Control connection`)
      }
    })
    if (
      browserStarts[0]?.config?.voiceRuntimeProvider !== 'hume' ||
      browserStarts[0]?.config?.languageModelMode !== 'codex' ||
      humeCalls.some((item) =>
        item.config?.voiceRuntimeProvider !== 'hume' ||
        item.config?.languageModelMode !== 'codex'
      )
    ) {
      failures.push('Playground call-method runtime fixture: Hume Codex routing did not survive Browser/Phone transport selection')
    }
    if (
      inworldCall?.config?.voiceRuntimeProvider !== 'inworld' ||
      inworldCall?.config?.languageModelMode !== 'inworld' ||
      inworldCall?.config?.inworldLanguageModel !== 'INWORLD:inworld-llm'
    ) {
      failures.push('Playground call-method runtime fixture: Inworld native routing did not survive Phone transport selection')
    }
    if (
      xaiCall?.config?.voiceRuntimeProvider !== 'xai' ||
      xaiCall?.config?.languageModelMode !== 'xai' ||
      xaiCall?.config?.languageModelProvider !== 'XAI_VOICE' ||
      xaiCall?.config?.xaiRealtimeModel !== 'grok-voice-latest' ||
      xaiCall?.config?.voice !== 'eve' ||
      xaiCall?.config?.xaiOutputSampleRate !== 16000
    ) {
      failures.push('Playground call-method runtime fixture: xAI native voice/model/phone routing did not survive Phone transport selection')
    }
    if (calltoolsRequests.length > 0) {
      failures.push('Playground call-method fixture touched a CallTools endpoint')
    }
    if (!browserLiveBeforeTurn || !browserWaitingBeforeTurn) {
      failures.push('Playground call-method browser fixture did not render an immediate live transcript attempt')
    }
    if (!browserEnds.includes(browserId) || phoneEnds.length !== 4) {
      failures.push('Playground call-method lifecycle fixture did not end every started Browser/Phone session')
    }
    if (
      phoneInstructions[0]?.id !== 'qa-phone-1' ||
      phoneInstructions[0]?.payload?.instruction !== 'Keep the phone conversation moving' ||
      phoneInstructions[0]?.payload?.chatId !== 'qa-chat-1'
    ) {
      failures.push('Playground call-method phone fixture did not route composer input to the active phone session')
    }
    if (providerSyncs.length >= browserStarts.length + callStarts.length) {
      failures.push('Playground call-method fixture forced a provider sync for every Browser/Phone start')
    }

    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${baseUrl}/configs`, { waitUntil: 'domcontentloaded' })
    await page
      .locator('[data-testid="speak-config-test-panel"]')
      .waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('[data-testid="speak-config-test-toggle"]').click()
    await page
      .getByLabel('Speak/Telnyx phone-test caller ID')
      .locator('option')
      .nth(1)
      .waitFor({ state: 'attached', timeout: 3000 })
    const phoneViewportMetrics = await page.evaluate(() => {
      const visible = (node) => {
        if (!node) return false
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
      }
      const popover = document.querySelector('.config-phone-test-popover')
      const bounds = popover?.getBoundingClientRect()
      return {
        browserVisible: visible(document.querySelector('[data-action-id="start_config_test"][role="menuitem"]')),
        deviceVisible: visible(document.querySelector('[data-action-id="call_lead_from_device"]')),
        numberOptionCount:
          document.querySelector('[aria-label="Speak/Telnyx phone-test caller ID"]')
            ?.querySelectorAll('option').length || 0,
        overflowLeft: bounds ? Math.max(0, -bounds.left) : null,
        overflowRight: bounds ? Math.max(0, bounds.right - window.innerWidth) : null,
        phoneVisible: visible(document.querySelector('[data-action-id="start_config_phone_test"]')),
        popoverVisible: visible(popover),
        readinessVisible: visible(document.querySelector('.config-phone-test-readiness')),
      }
    })
    if (
      !phoneViewportMetrics.popoverVisible ||
      !phoneViewportMetrics.browserVisible ||
      !phoneViewportMetrics.phoneVisible ||
      !phoneViewportMetrics.deviceVisible ||
      !phoneViewportMetrics.readinessVisible ||
      phoneViewportMetrics.numberOptionCount !== phoneNumbers.length ||
      Number(phoneViewportMetrics.overflowLeft || 0) > 1 ||
      Number(phoneViewportMetrics.overflowRight || 0) > 1
    ) {
      failures.push(
        `Playground call-method phone viewport fixture is incomplete or overflowing (${JSON.stringify(phoneViewportMetrics)})`,
      )
    }

    await page.getByRole('menuitem', { name: /Phone test\./ }).click()
    await waitForUiContractCondition(() => callStarts.length === 5)
    const mobileCallId = 'qa-phone-5'
    await page.waitForFunction(
      (id) => globalThis.__speakQaHasSessionEventSource?.(id) === true,
      mobileCallId,
      { timeout: 10000 },
    )
    await page.evaluate(
      (callId) => globalThis.__speakQaEmitSessionEvent?.(callId, {
        entry: {
          at: '4:02:00 PM',
          speaker: 'Lead',
          text: 'Mobile phone fixture caller',
          tone: 'neutral',
        },
        notice: 'Mobile phone fixture live',
        patch: {
          chatId: 'qa-chat-5',
          phase: 'live',
          streamId: 'qa-stream-5',
        },
      }),
      mobileCallId,
    )
    await page
      .getByTestId('speak-playground-phone-supervision')
      .waitFor({ state: 'visible', timeout: 3000 })
    const mobileSupervisionMetrics = await page.evaluate(() => {
      const group = document.querySelector(
        '[data-testid="speak-playground-phone-supervision"]',
      )
      const bounds = group?.getBoundingClientRect()
      const controls = [
        'toggle_playground_spy',
        'toggle_playground_barge',
        'toggle_playground_audio_whisper',
      ].map((actionId) => {
        const node = document.querySelector(`[data-action-id="${actionId}"]`)
        const rect = node?.getBoundingClientRect()
        const style = node ? getComputedStyle(node) : null
        return {
          actionId,
          visible: Boolean(
            rect &&
            style &&
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none'
          ),
          width: Math.round(rect?.width || 0),
        }
      })
      return {
        controls,
        documentOverflowX:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        groupOverflowLeft: bounds ? Math.max(0, -bounds.left) : null,
        groupOverflowRight: bounds
          ? Math.max(0, bounds.right - window.innerWidth)
          : null,
        placeholder:
          document.querySelector('.playground-composer textarea')?.getAttribute('placeholder') || '',
      }
    })
    if (
      mobileSupervisionMetrics.controls.some(
        (control) => !control.visible || control.width < 38,
      ) ||
      mobileSupervisionMetrics.documentOverflowX > 0 ||
      Number(mobileSupervisionMetrics.groupOverflowLeft || 0) > 1 ||
      Number(mobileSupervisionMetrics.groupOverflowRight || 0) > 1 ||
      !/Whisper to .* privately/.test(mobileSupervisionMetrics.placeholder)
    ) {
      failures.push(
        `Playground Phone supervision mobile controls are incomplete or overflowing (${JSON.stringify(mobileSupervisionMetrics)})`,
      )
    }
    await page.locator('[data-testid="speak-config-test-toggle"]').click()
    await waitForUiContractCondition(() => phoneEnds.length === 5)

    summaries.push({
      routeId: 'playground-call-methods',
      viewport: 'desktop',
      blockedMetrics,
      browserStarts: browserStarts.length,
      browserEnds: browserEnds.length,
      callStarts: callStarts.map((item) => ({
        callerId: item.config?.telnyxCallerId,
        connectionId: item.config?.telnyxConnectionId,
        dialerProvider: item.config?.dialerProvider,
        languageModelMode: item.config?.languageModelMode,
        runtime: item.config?.voiceRuntimeProvider,
      })),
      phoneEnds: phoneEnds.length,
      phoneInstructions: phoneInstructions.length,
      profileWrites: profileWrites.length,
      providerSyncs: providerSyncs.length,
    })
    summaries.push({
      routeId: 'playground-call-methods',
      viewport: 'phone',
      ...phoneViewportMetrics,
      supervision: mobileSupervisionMetrics,
    })
    if (localConsoleEntries.length > 0) {
      failures.push(`Playground call-method browser console issues: ${localConsoleEntries.join(' | ')}`)
    }
  } catch (error) {
    const debugState = await page.evaluate(() => ({
      body: document.body.innerText.slice(0, 1200),
      href: window.location.href,
      title: document.title,
    })).catch(() => null)
    failures.push(
      `Playground call-method browser fixture failed (${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify(debugState)})`,
    )
  } finally {
    await page.unroute('**/api/**', apiHandler)
    await page.close()
  }
}

async function verifyCallToolsAvailabilityRoutePersistence({
  baseUrl,
  failures,
  page,
  summaries,
}) {
  const now = '2026-07-15T18:00:00.000Z'
  const jaiProfileId = 'agent-config-cdf81f06-7610-4168-9039-6cd7b999e173'
  const staleProfileId = 'agent-config-calltools-default'
  const sourceId = 'calltools:campaign:12345'
  const dialerSourceId = `source:calltools::${encodeURIComponent(sourceId)}`
  let duty = {
    autoRearm: true,
    backendMonitored: true,
    binding: {
      appUserId: 'bb4d2683-09d6-4ea6-9642-c6e183960f30',
      campaignId: '12345',
      phoneId: '39833',
    },
    blockers: [],
    lastCheckedAt: now,
    lastVerifiedAt: now,
    leaseId: 'speak-qa-jai-stan-availability-lease',
    message: 'CallTools agent is Available and monitored by Speak.',
    profileId: jaiProfileId,
    reason: 'calltools_duty_verified',
    status: 'on',
  }
  const jaiProfile = {
    id: jaiProfileId,
    name: 'jAI-Stan',
    updatedAt: now,
    config: {
      agentProfileId: jaiProfileId,
      agentProfileName: 'jAI-Stan',
      calltoolsAgentBinding: {
        ...duty.binding,
        contactMatchMode: 'calltools_contact_id_then_phone',
        enabled: true,
        mode: 'phone_as_agent',
      },
      dialerProvider: 'calltools',
      instructions: 'Speak QA jAI-Stan profile.',
    },
    testVariables: {},
  }
  const staleProfile = {
    id: staleProfileId,
    name: 'calltools.default',
    updatedAt: now,
    config: {
      agentProfileId: staleProfileId,
      agentProfileName: 'calltools.default',
      calltoolsAgentBinding: {
        ...duty.binding,
        contactMatchMode: 'calltools_contact_id_then_phone',
        enabled: true,
        mode: 'phone_as_agent',
      },
      dialerProvider: 'calltools',
      instructions: 'Stale fallback profile that must not replace the leased agent.',
    },
    testVariables: {},
  }
  const lead = {
    id: 'speak-qa-calltools-contact',
    name: 'Speak QA Contact',
    company: 'Speak QA Campaign',
    email: 'speak-qa@example.com',
    phone: '+15555550199',
    state: 'NY',
    status: 'new',
    score: 80,
    source: 'calltools',
    sourceId,
    sourceName: 'CallTools campaign 12345',
    lastCall: 'Never',
    notes: '',
    tags: [],
  }
  let dialerState = {
    sourceId: dialerSourceId,
    activeSmartViewId: '',
    query: '',
    statusFilter: 'all',
    stateFilter: 'all',
    scoreFilter: 'all',
    selectedLeadId: lead.id,
    selectedLeadIds: [],
    campaignQueueIds: [],
    campaignRunning: true,
    scheduledStartAt: '',
    scheduledQueueActive: false,
    controllerId: 'speak-qa-controller',
    controllerHeartbeatAt: now,
    calltoolsDuty: duty,
    updatedAt: now,
  }
  const agentSessionRequests = []
  const dialerStateWrites = []
  const readinessProfileRequests = []
  const unexpectedApiMutations = []
  let persistedActiveProfileId = staleProfileId
  const routeHandlers = [
    [
      '**/api/**',
      (route) => {
        const request = route.request()
        if (request.method() !== 'GET') {
          unexpectedApiMutations.push({
            method: request.method(),
            url: request.url(),
          })
          return route.fulfill({
            status: 409,
            json: { error: 'Unexpected mutation blocked by availability persistence QA.' },
          })
        }
        return route.fulfill({ json: {} })
      },
    ],
    [
      '**/api/health',
      (route) => route.fulfill({
        json: {
          ok: true,
          configured: true,
          missing: [],
          message: 'Voice backend ready',
          defaults: {},
        },
      }),
    ],
    [
      '**/api/profiles',
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 120))
        try {
          return await route.fulfill({
            json: {
              activeProfileId: persistedActiveProfileId,
              profiles: [staleProfile, jaiProfile],
            },
          })
        } catch (error) {
          if (/route is already handled|target page.*closed/i.test(String(error))) return
          throw error
        }
      },
    ],
    ['**/api/leads', (route) => route.fulfill({ json: { leads: [lead] } })],
    ['**/api/smart-views', (route) => route.fulfill({ json: { smartViews: [] } })],
    ['**/api/calls/recent**', (route) => route.fulfill({ json: { calls: [] } })],
    [
      '**/api/communication-threads**',
      (route) => route.fulfill({ json: { threads: [] } }),
    ],
    [
      '**/api/dialer-state',
      (route) => {
        const request = route.request()
        if (request.method() === 'PATCH') {
          const requestBody = request.postDataJSON() || {}
          const patch = requestBody.dialerState || requestBody
          dialerStateWrites.push(structuredClone(patch))
          dialerState = {
            ...dialerState,
            ...patch,
            sourceId: dialerSourceId,
            campaignRunning: duty.status !== 'off',
            calltoolsDuty: duty,
            updatedAt: now,
          }
        }
        return route.fulfill({
          json: {
            dialerState: {
              ...dialerState,
              campaignRunning: duty.status !== 'off',
              calltoolsDuty: duty,
            },
          },
        })
      },
    ],
    [
      '**/api/calltools/readiness**',
      (route) => {
        const profileId = new URL(route.request().url()).searchParams.get('profileId') || ''
        const expectedProfileId = jaiProfileId
        readinessProfileRequests.push({
          expectedProfileId,
          profileId,
          status: duty.status,
        })
        if (profileId !== expectedProfileId) {
          return route.fulfill({
            status: 404,
            json: {
              code: 'profile_not_found',
              error: 'Profile not found',
            },
          })
        }
        return route.fulfill({
          json: {
            ready: true,
            runtimeReady: true,
            directStartReady: true,
            campaignReady: true,
            liveCallAttached: false,
            blockers: [],
            dutyMonitor: duty,
          },
        })
      },
    ],
    [
      '**/api/calltools/agent-session',
      (route) => {
        const request = route.request()
        agentSessionRequests.push({
          method: request.method(),
          body: request.postDataJSON() || {},
        })
        return route.fulfill({
          status: 409,
          json: { error: 'Availability persistence QA blocked an unexpected agent-session mutation.' },
        })
      },
    ],
  ]

  for (const [pattern, handler] of routeHandlers) {
    await page.route(pattern, handler)
  }

  async function collectPhase(
    phase,
    {
      expectedActionId = 'stop_queue',
      expectedAgentName = 'jAI-Stan',
      expectedDisabled = false,
      expectedRunLabel = 'Go unavailable',
    } = {},
  ) {
    await page
      .waitForFunction(
        ({ actionId, agentName, disabled, runLabel }) => {
          const routeNode = document.querySelector('[data-testid="speak-route-dialer"]')
          const runButton = document.querySelector(`[data-action-id="${actionId}"]`)
          const setup = document.querySelector('[data-action-id="configure_dialer"]')
          return Boolean(
            routeNode &&
              runButton?.textContent?.replace(/\s+/g, ' ').trim() === runLabel &&
              runButton?.disabled === disabled &&
              (!agentName || (setup?.getAttribute('aria-label') || '').includes(agentName)),
          )
        },
        {
          actionId: expectedActionId,
          agentName: expectedAgentName,
          disabled: expectedDisabled,
          runLabel: expectedRunLabel,
        },
        { timeout: 5000 },
      )
      .catch(() => {})
    const metrics = await page.evaluate(() => {
      const runButton = document.querySelector('.dialer-run-button.calltools-follow-mode')
      const setup = document.querySelector('[data-action-id="configure_dialer"]')
      return {
        renderedRouteId:
          document.querySelector('[data-testid="speak-route-dialer"]')?.getAttribute('data-route-id') || '',
        runActionId: runButton?.getAttribute('data-action-id') || '',
        runDisabled: Boolean(runButton?.disabled),
        runLabel: runButton?.textContent?.replace(/\s+/g, ' ').trim() || '',
        setupLabel: setup?.getAttribute('aria-label') || '',
      }
    })
    summaries.push({
      routeId: 'calltools-availability-persistence',
      viewport: 'desktop',
      phase,
      ...metrics,
    })
    if (metrics.renderedRouteId !== 'dialer') {
      failures.push(`CallTools availability persistence ${phase}: Dialer did not render`)
    }
    if (metrics.runLabel !== expectedRunLabel) {
      failures.push(
        `CallTools availability persistence ${phase}: expected ${expectedRunLabel}, saw ${metrics.runLabel || 'no action'}`,
      )
    }
    if (metrics.runActionId !== expectedActionId) {
      failures.push(
        `CallTools availability persistence ${phase}: expected action ${expectedActionId}, saw ${metrics.runActionId || 'no action'}`,
      )
    }
    if (metrics.runDisabled !== expectedDisabled) {
      failures.push(
        `CallTools availability persistence ${phase}: expected disabled=${expectedDisabled}, saw disabled=${metrics.runDisabled}`,
      )
    }
    if (expectedAgentName && !metrics.setupLabel.includes(expectedAgentName)) {
      failures.push(
        `CallTools availability persistence ${phase}: leased jAI-Stan was not displayed (${metrics.setupLabel || 'no setup label'})`,
      )
    }
  }

  try {
    await page.setViewportSize({ width: 1378, height: 790 })
    await page.goto(`${baseUrl}/dialer`, { waitUntil: 'domcontentloaded' })
    await collectPhase('initial')

    await page.locator('[data-action-id="route_to_configs"]').click({ timeout: 3000 })
    await page
      .waitForSelector('[data-testid="speak-route-configs"]', {
        state: 'visible',
        timeout: 3000,
      })
      .catch(() => {})
    await page.locator('[data-action-id="route_to_dialer"]').click({ timeout: 3000 })
    await collectPhase('after-playground-return')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await collectPhase('after-reload')

    duty = {
      ...duty,
      message: 'Speak is making the CallTools agent Unavailable.',
      status: 'disarming',
    }
    dialerState = {
      ...dialerState,
      campaignRunning: false,
      calltoolsDuty: duty,
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await collectPhase('disarming', {
      expectedDisabled: true,
      expectedRunLabel: 'Making unavailable…',
    })

    await page.locator('[data-action-id="route_to_configs"]').click({ timeout: 3000 })
    await page
      .waitForSelector('[data-testid="speak-route-configs"]', {
        state: 'visible',
        timeout: 3000,
      })
      .catch(() => {})
    await page.locator('[data-action-id="route_to_dialer"]').click({ timeout: 3000 })
    await collectPhase('disarming-after-playground-return', {
      expectedDisabled: true,
      expectedRunLabel: 'Making unavailable…',
    })

    if (dialerState.calltoolsDuty.leaseId !== duty.leaseId) {
      failures.push('CallTools availability persistence: durable lease ID changed while disarming')
    }
    const dialerStateWritesBeforeOff = [...dialerStateWrites]

    // A successful production arming persists the leased profile as the workspace
    // selection. Preserve the stale-profile cold-start coverage above, then mirror
    // that backend invariant before testing the completed unavailable handoff.
    persistedActiveProfileId = jaiProfileId
    duty = {
      ...duty,
      leaseId: '',
      message: 'CallTools agent is Unavailable.',
      status: 'off',
    }
    dialerState = {
      ...dialerState,
      campaignRunning: false,
      calltoolsDuty: duty,
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await collectPhase('off', {
      expectedActionId: 'start_queue',
      expectedAgentName: '',
      expectedRunLabel: 'Go available',
    })

    jaiProfile.config = {
      ...jaiProfile.config,
      dialerProvider: 'speak',
      calltoolsAgentBinding: {
        ...jaiProfile.config.calltoolsAgentBinding,
        enabled: false,
      },
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await collectPhase('off-transport-neutral-profile', {
      expectedActionId: 'start_queue',
      expectedDisabled: false,
      expectedRunLabel: 'Go available',
    })
    const transportNeutralTitle = await page
      .locator('.dialer-run-button.calltools-follow-mode')
      .first()
      .getAttribute('title')
    if (!transportNeutralTitle?.includes('Start the selected CallTools campaign and make this agent Available')) {
      failures.push(
        `CallTools availability persistence off-transport-neutral-profile: missing availability guidance (${transportNeutralTitle || 'no title'})`,
      )
    }

    if (agentSessionRequests.length > 0) {
      failures.push(
        `CallTools availability persistence: route/reload sent ${agentSessionRequests.length} agent-session mutation(s)`,
      )
    }
    const misroutedReadinessRequests = readinessProfileRequests.filter(
      (request) => request.profileId !== request.expectedProfileId,
    )
    if (misroutedReadinessRequests.length > 0) {
      failures.push(
        `CallTools availability persistence: readiness used unresolved or non-authoritative profile(s) ${misroutedReadinessRequests
          .map((request) => `${request.status}:${request.profileId || 'missing'}->${request.expectedProfileId}`)
          .join(', ')}`,
      )
    }
    if (!readinessProfileRequests.some((request) => request.profileId === jaiProfileId)) {
      failures.push(
        'CallTools availability persistence: leased jAI-Stan readiness was never requested',
      )
    }
    const releasingWrites = dialerStateWritesBeforeOff.filter(
      (write) =>
        write.campaignRunning === false ||
        write.calltoolsDuty?.status === 'off' ||
        write.calltoolsDuty?.leaseId === '',
    )
    if (releasingWrites.length > 0) {
      failures.push(
        `CallTools availability persistence: route/reload attempted ${releasingWrites.length} releasing dialer-state write(s)`,
      )
    }
    const unexpectedNonDialerMutations = unexpectedApiMutations.filter(
      (entry) => !entry.url.includes('/api/dialer-state'),
    )
    if (unexpectedNonDialerMutations.length > 0) {
      failures.push(
        `CallTools availability persistence: unexpected API mutations ${unexpectedNonDialerMutations
          .map((entry) => `${entry.method} ${entry.url}`)
          .join(', ')}`,
      )
    }
    if (dialerState.calltoolsDuty.leaseId !== '') {
      failures.push('CallTools availability persistence: backend off proof did not clear the lease')
    }
  } finally {
    for (const [pattern, handler] of [...routeHandlers].reverse()) {
      await page.unroute(pattern, handler).catch(() => {})
    }
  }
}

async function verifyGlobalSearchFixtureActivation({
  failures,
  page,
  summaries,
  viewportName,
}) {
  const leadId = `speak-qa-lead-activation-${viewportName}`
  const smartViewId = `speak-qa-view-activation-${viewportName}`
  const threadId = `speak-qa-thread-activation-${viewportName}`
  const probe = `speak qa activation ${viewportName}`
  const cleanup = await installGlobalSearchFixtureRoutes(page, {
    leadId,
    probe,
    smartViewId,
    threadId,
  })

  try {
    await page.goto(`${baseUrl}/library`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
    await page.getByTestId('speak-global-search-trigger').click({ timeout: 3000 })
    const input = page.locator('[data-testid="speak-global-search-dialog"] input').first()
    await input.fill(probe)
    await page
      .waitForFunction(() => {
        const dialog = document.querySelector('[data-testid="speak-global-search-dialog"]')
        return (dialog?.querySelectorAll('.global-search-result').length || 0) === 1
      }, null, { timeout: 5000 })
      .catch(() => {})

    const beforeSelect = await collectGlobalSearchActivationMetrics(page, threadId)
    summaries.push({
      routeId: 'global-search-activation-library',
      viewport: viewportName,
      phase: 'before-select',
      ...beforeSelect,
    })

    if (!beforeSelect.dialogVisible || beforeSelect.resultCount !== 1) {
      failures.push(
        `${viewportName} global search activation: expected one fixture result before selection`,
      )
      return
    }
    if (!beforeSelect.resultKinds.includes('thread')) {
      failures.push(
        `${viewportName} global search activation: fixture result should be a thread result`,
      )
      return
    }

    await input.press('Enter')
    await page
      .waitForFunction(
        (expectedThreadId) =>
          window.location.hash === `#thread=${encodeURIComponent(expectedThreadId)}` &&
          !document.querySelector('[data-testid="speak-global-search-dialog"]'),
        threadId,
        { timeout: 5000 },
      )
      .catch(() => {})
    await page
      .waitForSelector('[data-testid="speak-transcript-library"]', {
        state: 'visible',
        timeout: 5000,
      })
      .catch(() => {})

    const afterSelect = await collectGlobalSearchActivationMetrics(page, threadId)
    summaries.push({
      routeId: 'global-search-activation-library',
      viewport: viewportName,
      phase: 'after-select',
      ...afterSelect,
    })

    if (afterSelect.dialogVisible) {
      failures.push(
        `${viewportName} global search activation: selecting a result did not close the dialog`,
      )
    }
    if (!afterSelect.hashMatched) {
      failures.push(
        `${viewportName} global search activation: selecting a result did not navigate to the expected thread hash`,
      )
    }
    if (!afterSelect.threadStatusSelected) {
      failures.push(
        `${viewportName} global search activation: Library did not load the selected thread deep link`,
      )
    }

    await verifyFixtureThreadReplyComposers({
      failures,
      page,
      summaries,
      threadId,
      viewportName,
    })

    await verifyGlobalSearchFixtureDialerActivation({
      failures,
      leadId,
      page,
      summaries,
      viewportName,
    })
  } catch (error) {
    failures.push(
      `${viewportName} global search activation: fixture activation check failed (${error instanceof Error ? error.message : String(error)})`,
    )
  } finally {
    await cleanup()
  }
}

async function verifyGlobalSearchFixtureDialerActivation({
  failures,
  leadId,
  page,
  summaries,
  viewportName,
}) {
  const beforeUrl = `${baseUrl}/dialer`
  await page.goto(beforeUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
  await page
    .waitForSelector(`.lead-contact-row[data-lead-id="${leadId}"]`, {
      state: 'visible',
      timeout: 5000,
    })
    .catch(() => {})

  const initialMetrics = await collectGlobalSearchFixtureDialerMetrics(page, leadId)
  summaries.push({
    routeId: 'global-search-activation-dialer',
    viewport: viewportName,
    phase: 'initial',
    ...initialMetrics,
  })
  if (!initialMetrics.targetLeadVisible) {
    failures.push(
      `${viewportName} global search activation: fixture dialer lead did not render before selection`,
    )
    return
  }

  await page.getByTestId('speak-global-search-trigger').click({ timeout: 3000 })
  const input = page.locator('[data-testid="speak-global-search-dialog"] input').first()
  await input.fill('Speak QA Search Probe Co')
  const result = page
    .locator(
      `[data-testid="speak-global-search-dialog"] .global-search-result[data-search-result-id="lead:${leadId}"]`,
    )
    .first()
  await result.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})

  const beforeSelect = await collectGlobalSearchFixtureDialerMetrics(page, leadId)
  summaries.push({
    routeId: 'global-search-activation-dialer',
    viewport: viewportName,
    phase: 'before-select',
    ...beforeSelect,
  })
  if (!beforeSelect.dialogVisible || !beforeSelect.targetResultVisible) {
    failures.push(
      `${viewportName} global search activation: fixture dialer lead result was not visible before selection`,
    )
    await page.keyboard.press('Escape').catch(() => {})
    return
  }

  await result.click()
  await page
    .waitForFunction(
      (expectedLeadId) =>
        !document.querySelector('[data-testid="speak-global-search-dialog"]') &&
        Array.from(document.querySelectorAll('.lead-contact-row.lead-active'))
          .some((row) => row.getAttribute('data-lead-id') === expectedLeadId),
      leadId,
      { timeout: 5000 },
    )
    .catch(() => {})

  const afterSelect = await collectGlobalSearchFixtureDialerMetrics(page, leadId)
  summaries.push({
    routeId: 'global-search-activation-dialer',
    viewport: viewportName,
    phase: 'after-select',
    urlChanged: page.url() !== beforeUrl,
    ...afterSelect,
  })
  if (afterSelect.dialogVisible) {
    failures.push(
      `${viewportName} global search activation: fixture dialer selection did not close the dialog`,
    )
  }
  if (!afterSelect.targetLeadActive) {
    failures.push(
      `${viewportName} global search activation: fixture dialer lead was not activated after selection`,
    )
  }
  if (page.url() !== beforeUrl) {
    failures.push(
      `${viewportName} global search activation: fixture dialer selection changed route unexpectedly`,
    )
  }
}

async function verifyFixtureThreadReplyComposers({
  failures,
  page,
  summaries,
  threadId,
  viewportName,
}) {
  const sendRequests = []
  const healthHandler = (route) =>
    route.fulfill({
      json: {
        ok: true,
        configured: true,
        delivery: {
          emailConfigured: true,
          emailSendAsConfigured: true,
          smsConfigured: true,
        },
      },
    })
  const sendHandler = async (route) => {
    const request = route.request()
    const body = request.postDataJSON?.() || JSON.parse(request.postData() || '{}')
    sendRequests.push(body)
    if (body.channel === 'email') {
      return route.fulfill({
        json: {
          ok: false,
          error: 'QA email send rejected.',
        },
      })
    }
    return route.fulfill({
      json: {
        ok: true,
        sent: true,
        channel: body.channel,
        message: {
          messageId: `${threadId}-sent-${sendRequests.length}`,
          threadId,
        },
        proof: {
          provider: body.channel === 'sms' ? 'telnyx' : 'workspace-email',
          providerMessageId: `qa-${body.channel}-proof-${sendRequests.length}`,
        },
      },
    })
  }
  await page.route('**/api/health', healthHandler)
  await page.route('**/api/communication-messages/send', sendHandler)

  try {
  await expandLibraryActivityThread(page, threadId)
  const rowSelector = `.transcript-library-row[data-thread-id="${cssAttributeValue(threadId)}"]`
  const smsReply = page
    .locator(`${rowSelector} .communication-message-entry.channel-sms.sms-received .reply-action`)
    .first()
  const emailReply = page
    .locator(`${rowSelector} .communication-message-entry.channel-email .reply-action`)
    .first()

  const replyAvailability = await page.evaluate((selector) => {
    const row = document.querySelector(selector)
    return {
      emailReplyCount: row?.querySelectorAll('.communication-message-entry.channel-email .reply-action').length || 0,
      smsReplyCount: row?.querySelectorAll('.communication-message-entry.channel-sms.sms-received .reply-action').length || 0,
    }
  }, rowSelector)
  summaries.push({
    routeId: 'fixture-thread-reply-composers',
    viewport: viewportName,
    phase: 'availability',
    ...replyAvailability,
  })

  const renderMetrics = await collectFixtureThreadRenderMetrics(page, rowSelector)
  summaries.push({
    routeId: 'fixture-thread-rendering',
    viewport: viewportName,
    phase: 'source-merge',
    ...renderMetrics,
  })

  if (renderMetrics.entryCount !== 4) {
    failures.push(
      `${viewportName} fixture thread rendering: expected 4 merged message bubbles, saw ${renderMetrics.entryCount}`,
    )
  }
  if (renderMetrics.smsReceivedCount !== 1) {
    failures.push(
      `${viewportName} fixture thread rendering: expected one received SMS bubble`,
    )
  }
  if (renderMetrics.emailCount !== 1 || renderMetrics.emailSubjectCount !== 1) {
    failures.push(
      `${viewportName} fixture thread rendering: expected one collapsed email subject bubble`,
    )
  }
  if (renderMetrics.callCount !== 1 || renderMetrics.callDuplicateProofTextCount !== 1) {
    failures.push(
      `${viewportName} fixture thread rendering: linked call/source duplicates did not collapse to one call bubble`,
    )
  }
  if (renderMetrics.duplicateMessageIdCount > 0) {
    failures.push(
      `${viewportName} fixture thread rendering: duplicate rendered message ids ${renderMetrics.duplicateMessageIds.join(', ')}`,
    )
  }

  if (replyAvailability.smsReplyCount < 1) {
    failures.push(`${viewportName} fixture thread reply: inbound SMS reply action is missing`)
    return
  }
  if (replyAvailability.emailReplyCount < 1) {
    failures.push(`${viewportName} fixture thread reply: inbound email reply action is missing`)
    return
  }

  await smsReply.click({ timeout: 3000 })
  await page
    .locator(`${rowSelector} [data-testid="speak-communication-reply-composer"]`)
    .waitFor({ state: 'visible', timeout: 3000 })
    .catch(() => {})
  let smsMetrics = await collectFixtureReplyComposerMetrics(page, rowSelector)
  summaries.push({
    routeId: 'fixture-thread-reply-composers',
    viewport: viewportName,
    phase: 'sms-agent-open',
    ...smsMetrics,
  })
  if (!smsMetrics.smsWrapperVisible) {
    failures.push(`${viewportName} fixture thread reply: SMS reply composer did not open`)
  }
  if (!smsMetrics.smsAgentModePressed || smsMetrics.smsDeviceModePressed) {
    failures.push(`${viewportName} fixture thread reply: SMS composer did not default to agent number`)
  }
  if (!smsMetrics.agentComposerVisible || !smsMetrics.agentSendDisabled) {
    failures.push(`${viewportName} fixture thread reply: agent SMS composer must render with disabled blank send`)
  }

  await page
    .locator(`${rowSelector} [data-testid="speak-contact-delivery-composer"][data-channel="sms"] textarea[aria-label="Text message"]`)
    .fill('QA agent-number SMS reply')
  await page
    .waitForFunction(
      (selector) => {
        const send = document.querySelector(
          `${selector} [data-testid="speak-contact-delivery-composer"][data-channel="sms"] [data-testid="speak-contact-delivery-send"]`,
        )
        return send && send.disabled === false
      },
      rowSelector,
      { timeout: 4000 },
    )
    .catch(() => {})
  const smsSendResponse = page
    .waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/communication-messages/send'),
      { timeout: 4000 },
    )
    .catch(() => null)
  await page
    .locator(`${rowSelector} [data-testid="speak-contact-delivery-composer"][data-channel="sms"] [data-testid="speak-contact-delivery-send"]`)
    .click({ timeout: 3000 })
  await smsSendResponse
  await page
    .waitForFunction(
      (selector) => !document.querySelector(`${selector} [data-testid="speak-communication-reply-composer"]`),
      rowSelector,
      { timeout: 4000 },
    )
    .catch(() => {})
  const smsSentMetrics = await collectFixtureReplyComposerMetrics(page, rowSelector)
  summaries.push({
    routeId: 'fixture-thread-reply-composers',
    viewport: viewportName,
    phase: 'sms-agent-sent',
    sendRequests: sendRequests.map((request) => ({ ...request })),
    ...smsSentMetrics,
  })
  const smsSendRequest = sendRequests.find((request) => request.channel === 'sms')
  if (
    smsSendRequest?.body !== 'QA agent-number SMS reply' ||
    smsSendRequest?.threadId !== threadId ||
    smsSendRequest?.messageId !== `${threadId}-sms-inbound` ||
    !smsSendRequest?.phone
  ) {
    failures.push(`${viewportName} fixture thread reply: agent SMS send did not POST the expected reply proof payload`)
  }
  if (smsSentMetrics.smsWrapperVisible) {
    failures.push(`${viewportName} fixture thread reply: successful agent SMS send did not close the composer`)
  }

  await smsReply.click({ timeout: 3000 })
  await page.getByTestId('speak-sms-reply-device-mode').click({ timeout: 3000 })
  await page.getByLabel('Device SMS body').fill('QA reply from current device')
  smsMetrics = await collectFixtureReplyComposerMetrics(page, rowSelector)
  summaries.push({
    routeId: 'fixture-thread-reply-composers',
    viewport: viewportName,
    phase: 'sms-device-filled',
    ...smsMetrics,
  })
  if (!smsMetrics.smsDeviceModePressed || smsMetrics.smsAgentModePressed) {
    failures.push(`${viewportName} fixture thread reply: SMS device mode was not selected`)
  }
  if (!smsMetrics.deviceSendEnabled || !smsMetrics.deviceHrefStartsWithSms) {
    failures.push(`${viewportName} fixture thread reply: device SMS mode did not produce an enabled sms: handoff after body entry`)
  }

  await page
    .locator(`${rowSelector} [data-testid="speak-communication-reply-composer"] [data-testid="speak-contact-delivery-cancel"]`)
    .first()
    .click({ timeout: 3000 })
  await page
    .locator(`${rowSelector} [data-testid="speak-communication-reply-composer"]`)
    .waitFor({ state: 'detached', timeout: 3000 })
    .catch(() => {})

  await emailReply.click({ timeout: 3000 })
  await page
    .locator(`${rowSelector} [data-testid="speak-contact-delivery-composer"][data-channel="email"]`)
    .waitFor({ state: 'visible', timeout: 3000 })
    .catch(() => {})
  const emailMetrics = await collectFixtureReplyComposerMetrics(page, rowSelector)
  summaries.push({
    routeId: 'fixture-thread-reply-composers',
    viewport: viewportName,
    phase: 'email-open',
    ...emailMetrics,
  })
  if (!emailMetrics.emailComposerVisible) {
    failures.push(`${viewportName} fixture thread reply: email reply composer did not open`)
  }
  if (emailMetrics.emailSubjectValue !== 'Re: Project follow-up') {
    failures.push(
      `${viewportName} fixture thread reply: email reply subject "${emailMetrics.emailSubjectValue}" did not preserve the Re: subject`,
    )
  }
  if (!emailMetrics.emailSendDisabled) {
    failures.push(`${viewportName} fixture thread reply: email send must remain disabled before body entry`)
  }

  await page
    .locator(`${rowSelector} [data-testid="speak-contact-delivery-composer"][data-channel="email"] textarea[aria-label="Email body"]`)
    .fill('QA email reply body')
  await page
    .waitForFunction(
      (selector) => {
        const send = document.querySelector(
          `${selector} [data-testid="speak-contact-delivery-composer"][data-channel="email"] [data-testid="speak-contact-delivery-send"]`,
        )
        return send && send.disabled === false
      },
      rowSelector,
      { timeout: 4000 },
    )
    .catch(() => {})
  const emailSendResponse = page
    .waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/communication-messages/send'),
      { timeout: 4000 },
    )
    .catch(() => null)
  await page
    .locator(`${rowSelector} [data-testid="speak-contact-delivery-composer"][data-channel="email"] [data-testid="speak-contact-delivery-send"]`)
    .click({ timeout: 3000 })
  await emailSendResponse
  await page
    .waitForFunction(
      (selector) => {
        const composer = document.querySelector(
          `${selector} [data-testid="speak-contact-delivery-composer"][data-channel="email"]`,
        )
        const text = Array.from(composer?.querySelectorAll('p') || [])
          .map((node) => node.textContent || '')
          .join(' ')
        return /QA email send rejected\./.test(text)
      },
      rowSelector,
      { timeout: 4000 },
    )
    .catch(() => {})
  const emailFailureMetrics = await collectFixtureReplyComposerMetrics(page, rowSelector)
  summaries.push({
    routeId: 'fixture-thread-reply-composers',
    viewport: viewportName,
    phase: 'email-send-failure',
    sendRequests: sendRequests.map((request) => ({ ...request })),
    ...emailFailureMetrics,
  })
  const emailSendRequest = sendRequests.find((request) => request.channel === 'email')
  if (
    emailSendRequest?.subject !== 'Re: Project follow-up' ||
    emailSendRequest?.body !== 'QA email reply body' ||
    emailSendRequest?.threadId !== threadId ||
    emailSendRequest?.messageId !== `${threadId}-email-inbound` ||
    emailSendRequest?.email !== 'search-probe@example.com'
  ) {
    failures.push(`${viewportName} fixture thread reply: email send did not POST the expected reply payload`)
  }
  if (!emailFailureMetrics.emailComposerVisible || !/QA email send rejected\./.test(emailFailureMetrics.noticeText)) {
    failures.push(`${viewportName} fixture thread reply: failed email send did not keep the composer open with backend error proof`)
  }
  if (/Email sent\./.test(emailFailureMetrics.noticeText)) {
    failures.push(`${viewportName} fixture thread reply: failed email send displayed a success notice`)
  }

  await page
    .locator(`${rowSelector} [data-testid="speak-contact-delivery-composer"][data-channel="email"] [data-testid="speak-contact-delivery-cancel"]`)
    .first()
    .click({ timeout: 3000 })
    .catch(() => {})
  } finally {
    await page.unroute('**/api/health', healthHandler).catch(() => {})
    await page.unroute('**/api/communication-messages/send', sendHandler).catch(() => {})
  }
}

async function collectFixtureThreadRenderMetrics(page, rowSelector) {
  return page.evaluate((selector) => {
    const row = document.querySelector(selector)
    const entries = Array.from(row?.querySelectorAll('.communication-message-entry') || [])
    const messageIds = entries
      .map((entry) => entry.getAttribute('data-message-id') || '')
      .filter(Boolean)
    const duplicateMessageIds = Array.from(new Set(
      messageIds.filter((id, index) => messageIds.indexOf(id) !== index),
    ))
    const count = (predicate) => entries.filter(predicate).length
    return {
      entryCount: entries.length,
      smsReceivedCount: count((entry) =>
        entry.getAttribute('data-channel') === 'sms' &&
        entry.classList.contains('sms-received'),
      ),
      smsSentCount: count((entry) =>
        entry.getAttribute('data-channel') === 'sms' &&
        entry.classList.contains('sms-sent'),
      ),
      emailCount: count((entry) => entry.getAttribute('data-channel') === 'email'),
      emailSubjectCount: row?.querySelectorAll(
        '.communication-message-entry[data-channel="email"] .communication-email-subject strong',
      ).length || 0,
      callCount: count((entry) => entry.getAttribute('data-channel') === 'call'),
      callDuplicateProofTextCount: count((entry) =>
        /Call duplicate proof/i.test(entry.textContent || ''),
      ),
      duplicateMessageIdCount: duplicateMessageIds.length,
      duplicateMessageIds,
    }
  }, rowSelector)
}

async function collectFixtureReplyComposerMetrics(page, rowSelector) {
  return page.evaluate((selector) => {
    const row = document.querySelector(selector)
    const isVisible = (node) => {
      if (!node) return false
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      )
    }
    const smsWrapper = row?.querySelector('[data-testid="speak-communication-reply-composer"]')
    const agentMode = row?.querySelector('[data-testid="speak-sms-reply-agent-mode"]')
    const deviceMode = row?.querySelector('[data-testid="speak-sms-reply-device-mode"]')
    const agentComposer = row?.querySelector('[data-testid="speak-contact-delivery-composer"][data-channel="sms"]')
    const agentSend = agentComposer?.querySelector('[data-testid="speak-contact-delivery-send"]')
    const deviceSend = smsWrapper?.querySelector('a[data-testid="speak-contact-delivery-send"]')
    const emailComposer = row?.querySelector('[data-testid="speak-contact-delivery-composer"][data-channel="email"]')
    const emailSubject = emailComposer?.querySelector('input[aria-label="Email subject"]')
    const emailSend = emailComposer?.querySelector('[data-testid="speak-contact-delivery-send"]')
    const visibleComposer = agentComposer || emailComposer
    const noticeText = Array.from(visibleComposer?.querySelectorAll('p') || [])
      .map((node) => node.textContent?.trim() || '')
      .filter(Boolean)
      .join(' ')
    return {
      smsWrapperVisible: isVisible(smsWrapper),
      smsAgentModePressed: agentMode?.getAttribute('aria-pressed') === 'true',
      smsDeviceModePressed: deviceMode?.getAttribute('aria-pressed') === 'true',
      agentComposerVisible: isVisible(agentComposer),
      agentSendDisabled: agentSend?.disabled === true,
      deviceSendEnabled:
        deviceSend?.getAttribute('aria-disabled') === 'false' &&
        Boolean(deviceSend?.getAttribute('href')),
      deviceHrefStartsWithSms: /^sms:/i.test(deviceSend?.getAttribute('href') || ''),
      emailComposerVisible: isVisible(emailComposer),
      emailSubjectValue: emailSubject?.value || '',
      emailSendDisabled: emailSend?.disabled === true,
      noticeText,
    }
  }, rowSelector)
}

async function installGlobalSearchFixtureRoutes(page, { leadId, probe, smartViewId, threadId }) {
  const now = new Date('2026-07-04T16:00:00.000Z').toISOString()
  const fixtureLead = {
    id: leadId,
    firstName: 'Search',
    lastName: 'Probe',
    name: 'Search Probe',
    company: 'Speak QA Search Probe Co',
    phone: '+15555550123',
    email: 'search-probe@example.com',
    state: 'NC',
    tags: [],
    score: 0,
    status: 'ready',
    lastCall: 'Never',
    notes: '',
    context: { text: '', urls: [], files: [] },
    source: 'personal-phone',
    sourceId: 'bluebubbles:contacts',
    sourceName: 'Personal Phone Contacts',
  }
  const workspacePayload = {
    version: 1,
    updatedAt: now,
    leads: [fixtureLead],
    deletedLeadIds: [],
    deletedLeadFingerprints: [],
    smartViews: [
      {
        id: smartViewId,
        name: 'Speak QA Search View',
        source: 'filters',
        createdAt: now,
        updatedAt: now,
        leadIds: [fixtureLead.id],
        leadCount: 1,
        filters: {},
      },
    ],
    profiles: [
      {
        id: 'speak-qa-profile-activation',
        name: 'Speak QA Search Agent',
        updatedAt: now,
        config: {
          voiceRuntimeProvider: 'inworld',
          smartViewId: '',
          instructions: '',
        },
        context: { text: '', urls: [], files: [] },
      },
    ],
    activeProfileId: 'speak-qa-profile-activation',
    dialerState: {
      sourceId: 'source:personal-phone',
      activeSmartViewId: smartViewId,
      query: '',
      statusFilter: 'all',
      stateFilter: 'all',
      scoreFilter: 'all',
      tagFilter: 'all',
      selectedLeadId: '',
      selectedLeadIds: [],
      campaignQueueIds: [],
      campaignRunning: false,
      scheduledStartAt: '',
      scheduledQueueActive: false,
      updatedAt: now,
    },
    communicationThreads: [],
    communicationMessages: [],
    communicationTopics: [],
    contactIdentityLinks: [],
  }
  const threadsPayload = {
    threads: [
      {
        threadId,
        contactId: fixtureLead.id,
        status: 'open',
        channels: ['call', 'sms', 'email'],
        summary: probe,
        latestMessagePreview: probe,
        messageCount: 3,
        lastInboundAt: now,
        lastOutboundAt: now,
        participants: [
          {
            role: 'contact',
            label: 'QA Search Contact',
            contactId: fixtureLead.id,
          },
          {
            role: 'agent',
            label: 'Speak QA Search Agent',
          },
        ],
        providerLinks: [
          {
            provider: 'phoneProvider',
            kind: 'call_control',
            id: `${threadId}-call`,
          },
        ],
        updatedAt: now,
      },
    ],
  }
  const recentCallsPayload = {
    calls: [
      {
        callControlId: `${threadId}-call`,
        chatId: `${threadId}-voice-session`,
        createdAt: now,
        updatedAt: now,
        outcome: 'completed',
        phase: 'ended',
        transcriptTurns: 1,
        agent: {
          id: 'speak-qa-profile-activation',
          name: 'Speak QA Search Agent',
          voiceRuntimeProvider: 'inworld',
        },
        lead: {
          id: fixtureLead.id,
          name: fixtureLead.name,
          business_name: fixtureLead.company,
          phone_on_file: fixtureLead.phone,
          email_on_file: fixtureLead.email,
        },
        transcript: [
          {
            speaker: 'Lead',
            at: now,
            text: 'Call duplicate proof.',
            providerEventId: 'qa-call-duplicate-proof',
          },
        ],
      },
    ],
  }
  const messagesPayload = {
    messages: [
      {
        messageId: `${threadId}-call-stored-copy`,
        threadId,
        contactId: fixtureLead.id,
        channel: 'call',
        direction: 'inbound',
        role: 'contact',
        provider: 'inworld',
        body: 'Call duplicate proof.',
        at: now,
        providerIds: {
          callControlId: `${threadId}-call`,
          providerEventId: 'qa-call-duplicate-proof',
        },
      },
      {
        messageId: `${threadId}-sms-inbound`,
        threadId,
        contactId: fixtureLead.id,
        channel: 'sms',
        direction: 'inbound',
        role: 'contact',
        body: 'Can you send the QA details?',
        at: now,
        providerIds: {
          fromPhone: fixtureLead.phone,
          toPhone: '+15555550999',
        },
      },
      {
        messageId: `${threadId}-email-inbound`,
        threadId,
        contactId: fixtureLead.id,
        channel: 'email',
        direction: 'inbound',
        role: 'contact',
        body: 'Subject: Project follow-up\n\nCan you email the QA summary?',
        at: now,
        providerIds: {
          fromEmail: fixtureLead.email,
          toEmail: 'operator@example.com',
        },
      },
      {
        messageId: `${threadId}-sms-outbound`,
        threadId,
        contactId: fixtureLead.id,
        channel: 'sms',
        direction: 'outbound',
        role: 'agent',
        body: 'I sent the details.',
        at: now,
        providerIds: {
          fromPhone: '+15555550999',
          toPhone: fixtureLead.phone,
        },
      },
    ],
  }
  const routeHandlers = [
    [
      '**/api/search**',
      (route) => {
        const url = new URL(route.request().url())
        const query = String(url.searchParams.get('q') || '').trim().toLowerCase()
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 24)))
        const searchScore = (value) => {
          if (!query) return 1
          const haystack = String(value || '').toLowerCase()
          const index = haystack.indexOf(query)
          if (index === -1) return 0
          return index === 0 ? 4 : haystack.includes(` ${query}`) ? 3 : 2
        }
        const results = [
          {
            id: `lead:${fixtureLead.id}`,
            kind: 'lead',
            leadId: fixtureLead.id,
            title: fixtureLead.company,
            subtitle: fixtureLead.name,
            detail: fixtureLead.sourceName,
            score: searchScore([
              fixtureLead.company,
              fixtureLead.name,
              fixtureLead.email,
              fixtureLead.phone,
              fixtureLead.sourceName,
            ].join(' ')),
          },
          {
            id: `smart-view:${smartViewId}`,
            kind: 'smart-view',
            smartViewId,
            title: workspacePayload.smartViews[0].name,
            subtitle: 'Filtered Smart View',
            detail: '1 contacts',
            score: searchScore(workspacePayload.smartViews[0].name),
          },
          {
            id: 'profile:speak-qa-profile-activation',
            kind: 'profile',
            profileId: 'speak-qa-profile-activation',
            title: 'Speak QA Search Agent',
            subtitle: 'Agent profile',
            detail: now,
            score: searchScore('Speak QA Search Agent'),
            profile: workspacePayload.profiles[0],
          },
          {
            id: `thread:${threadId}`,
            kind: 'thread',
            threadId,
            title: 'QA Search Contact',
            subtitle: `call, sms, email / ${now}`,
            detail: probe,
            score: searchScore([
              'QA Search Contact',
              threadId,
              probe,
            ].join(' ')),
          },
        ]
          .filter((result) => result.score > 0)
          .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
          .slice(0, limit)
        return route.fulfill({
          json: {
            schemaVersion: 'speak.workspace-search.v1',
            query,
            limit,
            totalCandidates: {
              leads: workspacePayload.leads.length,
              profiles: workspacePayload.profiles.length,
              smartViews: workspacePayload.smartViews.length,
              threads: threadsPayload.threads.length,
            },
            resultCount: results.length,
            truncated: false,
            results,
          },
        })
      },
    ],
    ['**/api/workspace', (route) => route.fulfill({ json: workspacePayload })],
    ['**/api/leads', (route) => route.fulfill({ json: { leads: workspacePayload.leads } })],
    [
      '**/api/smart-views',
      (route) => route.fulfill({ json: { smartViews: workspacePayload.smartViews } }),
    ],
    [
      '**/api/dialer-state',
      (route) => route.fulfill({ json: { dialerState: workspacePayload.dialerState } }),
    ],
    [
      '**/api/calls/recent**',
      (route) => route.fulfill({ json: recentCallsPayload }),
    ],
    [
      '**/api/communication-threads**',
      (route) => {
        const url = route.request().url()
        return route.fulfill({
          json: /\/communication-threads\/[^/]+\/messages(?:\?|$)/.test(url)
            ? messagesPayload
            : threadsPayload,
        })
      },
    ],
  ]

  for (const [pattern, handler] of routeHandlers) {
    await page.route(pattern, handler)
  }

  return async () => {
    for (const [pattern, handler] of routeHandlers) {
      await page.unroute(pattern, handler).catch(() => {})
    }
  }
}

async function collectGlobalSearchFixtureDialerMetrics(page, leadId) {
  return page.evaluate((expectedLeadId) => {
    const isVisible = (node) => {
      if (!node) return false
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      )
    }
    const dialog = document.querySelector('[data-testid="speak-global-search-dialog"]')
    const targetRow = document.querySelector(`.lead-contact-row[data-lead-id="${expectedLeadId}"]`)
    const activeRow = document.querySelector(`.lead-contact-row.lead-active[data-lead-id="${expectedLeadId}"]`)
    const targetResult = document.querySelector(
      `[data-testid="speak-global-search-dialog"] .global-search-result[data-search-result-id="lead:${expectedLeadId}"]`,
    )
    return {
      dialogVisible: isVisible(dialog),
      targetLeadActive: isVisible(activeRow),
      targetLeadVisible: isVisible(targetRow),
      targetResultVisible: isVisible(targetResult),
    }
  }, leadId)
}

async function collectGlobalSearchActivationMetrics(page, threadId) {
  return page.evaluate((expectedThreadId) => {
    const isVisible = (node) => {
      if (!node) return false
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      )
    }
    const dialog = document.querySelector('[data-testid="speak-global-search-dialog"]')
    const resultNodes = Array.from(dialog?.querySelectorAll('.global-search-result') || [])
      .filter(isVisible)
    const resultKinds = Array.from(new Set(resultNodes.flatMap((node) =>
      Array.from(node.classList)
        .filter((className) => className.startsWith('search-kind-'))
        .map((className) => className.replace(/^search-kind-/, '')),
    )))
    return {
      dialogVisible: isVisible(dialog),
      hash: window.location.hash,
      hashMatched:
        window.location.hash === `#thread=${encodeURIComponent(expectedThreadId)}`,
      resultCount: resultNodes.length,
      resultKinds,
      threadStatusSelected:
        isVisible(document.querySelector('.transcript-thread-status.selected')) &&
        /QA Search Contact/i.test(
          document.querySelector('.transcript-thread-status.selected')?.textContent || '',
        ),
      transcriptLibraryVisible: isVisible(
        document.querySelector('[data-testid="speak-transcript-library"]'),
      ),
    }
  }, threadId)
}

async function verifyLibraryActivityRendering(page, viewportName, failures, summaries) {
  const channelExpectations = await loadActivityChannelExpectations(failures)

  try {
    await page.getByTestId('speak-library-activity-tab').click({
      noWaitAfter: true,
      timeout: 3000,
    })
  } catch (error) {
    failures.push(
      `${viewportName} library activity: Activity tab was not clickable (${error instanceof Error ? error.message : String(error)})`,
    )
    return
  }

  await page
    .waitForSelector('[data-testid="speak-transcript-library"]', {
      state: 'visible',
      timeout: 4000,
    })
    .catch(() => {})

  let activity = await collectLibraryActivityOverview(page)

  summaries.push({
    routeId: 'library-activity',
    viewport: viewportName,
    activityTabSelected: activity.activityTabSelected,
    libraryVisible: activity.libraryVisible,
    rowCount: activity.rowCount,
    statusText: activity.statusText,
  })

  if (!activity.activityTabSelected) {
    failures.push(`${viewportName} library activity: Activity tab did not remain selected`)
  }
  if (!activity.libraryVisible) {
    failures.push(`${viewportName} library activity: transcript activity surface was not visible`)
    return
  }

  let fixtureCleanup = null
  if (activity.rowCount === 0) {
    const fixtureLeadId = `speak-qa-activity-${viewportName}`
    const fixtureThreadId = `speak-qa-activity-thread-${viewportName}`
    fixtureCleanup = await installGlobalSearchFixtureRoutes(page, {
      leadId: fixtureLeadId,
      probe: 'QA activity source-history proof',
      smartViewId: `speak-qa-activity-view-${viewportName}`,
      threadId: fixtureThreadId,
    })
    await page.goto(`${baseUrl}/library`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
    await page.getByTestId('speak-library-activity-tab').click({
      noWaitAfter: true,
      timeout: 3000,
    })
    await page
      .waitForSelector('[data-testid="speak-transcript-library"]', {
        state: 'visible',
        timeout: 4000,
      })
      .catch(() => {})
    activity = await collectLibraryActivityOverview(page)
    summaries.push({
      routeId: 'library-activity-fixture',
      viewport: viewportName,
      activityTabSelected: activity.activityTabSelected,
      libraryVisible: activity.libraryVisible,
      rowCount: activity.rowCount,
      statusText: activity.statusText,
      fixtureThreadId,
    })
  }

  if (activity.rowCount === 0) {
    failures.push(
      `${viewportName} library activity: no activity rows available to prove source-history transcript rendering`,
    )
    if (fixtureCleanup) await fixtureCleanup()
    return
  }

  let expanded = null
  const rowLimit = Math.min(activity.rowCount, 5)
  for (let index = 0; index < rowLimit; index += 1) {
    const row = page.locator('.transcript-library-row:visible').nth(index)
    const threadId = await row.getAttribute('data-thread-id', { timeout: 3000 })
    if (!threadId) continue
    const current = await expandLibraryActivityThread(page, threadId)
    if (current.entryCount > 0) {
      expanded = current
      break
    }
    if (!expanded && current.previewVisible) expanded = current
  }

  summaries.push({
    routeId: 'library-activity-expanded',
    viewport: viewportName,
    ...(expanded || {}),
  })

  if (!expanded?.previewVisible) {
    failures.push(`${viewportName} library activity: expanding an activity row did not reveal the preview surface`)
    if (fixtureCleanup) await fixtureCleanup()
    return
  }
  if (expanded.entryCount === 0) {
    failures.push(
      `${viewportName} library activity: expanded rows did not render shared communication message bubbles`,
    )
    if (fixtureCleanup) await fixtureCleanup()
    return
  }
  if (expanded.rawTranscriptEntryCount > 0) {
    failures.push(
      `${viewportName} library activity: preview contains raw transcript entries outside the shared communication renderer`,
    )
  }
  if (expanded.headingCount < expanded.entryCount) {
    failures.push(
      `${viewportName} library activity: shared message bubbles are missing transcript-style participant headings`,
    )
  }
  if (expanded.copyActionCount < 1) {
    failures.push(`${viewportName} library activity: shared message bubbles are missing copy actions`)
  }
  if (expanded.speakerClassedCount < expanded.entryCount) {
    failures.push(
      `${viewportName} library activity: message bubbles are missing role/direction color-delegation classes`,
    )
  }
  if (expanded.channelEmailCount > 0 && expanded.emailSubjectCount < expanded.channelEmailCount) {
    failures.push(
      `${viewportName} library activity: collapsed email bubbles do not keep the subject visible`,
    )
  }
  if (expanded.channelSmsCount > 0 && expanded.classifiedSmsCount < expanded.channelSmsCount) {
    failures.push(
      `${viewportName} library activity: SMS bubbles are missing sent/received color assignment classes`,
    )
  }
  if (expanded.hasMissingScorePlaceholder) {
    failures.push(
      `${viewportName} library activity: source history rendered a missing-score placeholder`,
    )
  }
  assertActivityBubbleColorSamples({
    expanded,
    failures,
    label: `${viewportName} library activity`,
  })

  for (const target of libraryActivityChannelTargets) {
    await verifyLibraryActivityChannelTarget({
      channel: target.channel,
      expectations: channelExpectations,
      failures,
      page,
      summaries,
      summaryRouteId: target.summaryRouteId,
      viewportName,
    })
  }
  if (fixtureCleanup) await fixtureCleanup()
}

async function collectLibraryActivityOverview(page) {
  return page.evaluate(() => {
    const isVisible = (node) => {
      if (!node) return false
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      )
    }
    const library = document.querySelector('[data-testid="speak-transcript-library"]')
    const activityTab = document.querySelector('[data-testid="speak-library-activity-tab"]')
    const rows = Array.from(document.querySelectorAll('.transcript-library-row')).filter(isVisible)
    return {
      activityTabSelected: activityTab?.getAttribute('aria-selected') === 'true',
      libraryVisible: isVisible(library),
      rowCount: rows.length,
      statusText:
        document
          .querySelector('.transcript-thread-status')
          ?.textContent?.trim()
          .replace(/\s+/g, ' ') || '',
    }
  })
}

async function verifyLibraryActivityChannelTarget({
  channel,
  expectations,
  failures,
  page,
  summaries,
  summaryRouteId,
  viewportName,
}) {
  const target = expectations[channel]
  if (!target?.threadId) return
  const targetRow = page.locator(`.transcript-library-row[data-thread-id="${cssAttributeValue(target.threadId)}"]`)
  if ((await targetRow.count()) === 0 || !(await targetRow.first().isVisible().catch(() => false))) {
    summaries.push({
      routeId: summaryRouteId,
      viewport: viewportName,
      skipped: 'not-visible-in-selected-source',
      expected: {
        threadId: target.threadId,
        emailMessages: target.emailMessages,
        smsMessages: target.smsMessages,
        inboundEmail: target.inboundEmail,
        inboundSms: target.inboundSms,
        outboundSms: target.outboundSms,
      },
    })
    return
  }
  const expanded = await expandLibraryActivityThread(page, target.threadId)

  summaries.push({
    routeId: summaryRouteId,
    viewport: viewportName,
    expected: {
      threadId: target.threadId,
      emailMessages: target.emailMessages,
      smsMessages: target.smsMessages,
      inboundEmail: target.inboundEmail,
      inboundSms: target.inboundSms,
      outboundSms: target.outboundSms,
    },
    ...(expanded || {}),
  })

  if (!expanded?.previewVisible) {
    failures.push(
      `${viewportName} library activity: could not expand ${channel} thread ${target.threadId}`,
    )
    return
  }
  if (expanded.entryCount === 0) {
    failures.push(
      `${viewportName} library activity: ${channel} thread did not render shared message bubbles`,
    )
    return
  }
  if (channel === 'email') {
    if (expanded.channelEmailCount < 1) {
      failures.push(
        `${viewportName} library activity: production email thread rendered no email bubbles`,
      )
    }
    if (expanded.emailSubjectCount < expanded.channelEmailCount) {
      failures.push(
        `${viewportName} library activity: production email bubbles do not keep subjects visible`,
      )
    }
    if (target.inboundEmail > 0 && expanded.replyActionCount < 1) {
      failures.push(
        `${viewportName} library activity: inbound email bubble is missing a reply action`,
      )
    }
  }
  if (channel === 'sms') {
    if (expanded.channelSmsCount < 1) {
      failures.push(
        `${viewportName} library activity: production SMS thread rendered no SMS bubbles`,
      )
    }
    if (expanded.classifiedSmsCount < expanded.channelSmsCount) {
      failures.push(
        `${viewportName} library activity: production SMS bubbles are missing sent/received color classes`,
      )
    }
    if (target.inboundSms > 0 && expanded.receivedSmsCount < 1) {
      failures.push(
        `${viewportName} library activity: inbound SMS bubble did not render with received color class`,
      )
    }
    if (target.outboundSms > 0 && expanded.sentSmsCount < 1) {
      failures.push(
        `${viewportName} library activity: outbound SMS bubble did not render with sent color class`,
      )
    }
    if (target.inboundSms > 0 && expanded.replyActionCount < 1) {
      failures.push(
        `${viewportName} library activity: inbound SMS bubble is missing a reply action`,
      )
    }
  }
  if (expanded.hasMissingScorePlaceholder) {
    failures.push(
      `${viewportName} library activity: ${channel} thread rendered a missing-score placeholder`,
    )
  }
  assertActivityBubbleColorSamples({
    expanded,
    failures,
    label: `${viewportName} library activity ${channel} thread`,
  })
}

async function expandLibraryActivityThread(page, threadId) {
  const escapedThreadId = cssAttributeValue(threadId)
  const trigger = page.locator(`.transcript-library-row[data-thread-id="${escapedThreadId}"] .transcript-library-main`)
  if ((await trigger.getAttribute('aria-expanded', { timeout: 3000 })) !== 'true') {
    await trigger.click({ timeout: 3000 })
  }
  await page
    .waitForSelector(`.transcript-library-row[data-thread-id="${escapedThreadId}"] .transcript-library-preview`, {
      state: 'visible',
      timeout: 4000,
    })
    .catch(() => {})
  await page
    .waitForFunction(
      (targetThreadId) => {
        const root = document.querySelector(
          `.transcript-library-row[data-thread-id="${CSS.escape(String(targetThreadId))}"]`,
        )
        const isVisible = (node) => {
          if (!node) return false
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          )
        }
        const preview = Array.from(root?.querySelectorAll('.transcript-library-preview') || [])
          .find(isVisible)
        return (
          isVisible(preview) &&
          Array.from(preview.querySelectorAll('.communication-message-entry.transcript-entry'))
            .some(isVisible)
        )
      },
      threadId,
      { timeout: 6000 },
    )
    .catch(() => {})
  return collectVisibleLibraryActivityPreviewMetrics(page, threadId)
}

async function collectVisibleLibraryActivityPreviewMetrics(page, threadId = null) {
  return page.evaluate((targetThreadId) => {
    const isVisible = (node) => {
      if (!node) return false
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      )
    }
    const root = targetThreadId
      ? document.querySelector(`.transcript-library-row[data-thread-id="${CSS.escape(String(targetThreadId))}"]`)
      : document
    const preview = Array.from(root?.querySelectorAll('.transcript-library-preview') || []).find(isVisible)
    const count = (selector) => preview?.querySelectorAll(selector).length || 0
    const text = preview?.textContent?.replace(/\s+/g, ' ').trim() || ''
    const visibleStyleSample = (selector) => {
      const node = Array.from(preview?.querySelectorAll(selector) || []).find(isVisible)
      if (!node) return null
      const style = getComputedStyle(node)
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderColor: style.borderColor,
      }
    }
    const originalAppearance = document.documentElement.getAttribute('data-appearance')
    const colorSamples = {}
    for (const appearance of ['light', 'dark']) {
      document.documentElement.setAttribute('data-appearance', appearance)
      colorSamples[appearance] = {
        smsReceived: visibleStyleSample('.communication-message-entry.channel-sms.sms-received'),
        smsSent: visibleStyleSample('.communication-message-entry.channel-sms.sms-sent'),
        email: visibleStyleSample('.communication-message-entry.channel-email'),
      }
    }
    if (originalAppearance === null) {
      document.documentElement.removeAttribute('data-appearance')
    } else {
      document.documentElement.setAttribute('data-appearance', originalAppearance)
    }
    return {
      previewVisible: isVisible(preview),
      entryCount: count('.communication-message-entry.transcript-entry'),
      rawTranscriptEntryCount: count('.transcript-entry:not(.communication-message-entry)'),
      headingCount: count('.communication-message-entry .transcript-entry-heading'),
      copyActionCount: count('.communication-message-entry .chat-copy-action'),
      replyActionCount: count('.communication-message-entry .reply-action'),
      speakerClassedCount: count(
        '.communication-message-entry.speaker-ai, .communication-message-entry.speaker-lead, .communication-message-entry.speaker-you, .communication-message-entry.speaker-tool, .communication-message-entry.speaker-system, .communication-message-entry.sms-received, .communication-message-entry.sms-sent',
      ),
      channelEmailCount: count('.communication-message-entry.channel-email'),
      emailSubjectCount: count('.communication-message-entry.channel-email .communication-email-subject strong'),
      channelSmsCount: count('.communication-message-entry.channel-sms'),
      classifiedSmsCount: count('.communication-message-entry.channel-sms.sms-received, .communication-message-entry.channel-sms.sms-sent'),
      receivedSmsCount: count('.communication-message-entry.channel-sms.sms-received'),
      sentSmsCount: count('.communication-message-entry.channel-sms.sms-sent'),
      colorSamples,
      hasMissingScorePlaceholder: /missing score|no score|n\/a score/i.test(text),
      textLength: text.length,
    }
  }, threadId)
}

function assertActivityBubbleColorSamples({ expanded, failures, label }) {
  const expectations = [
    {
      enabled: expanded.receivedSmsCount > 0,
      key: 'smsReceived',
      description: 'received SMS bubble',
      light: {
        backgroundColor: 'rgb(0, 122, 255)',
        color: 'rgb(255, 255, 255)',
      },
      dark: {
        backgroundColor: 'rgb(10, 132, 255)',
        color: 'rgb(255, 255, 255)',
      },
    },
    {
      enabled: expanded.sentSmsCount > 0,
      key: 'smsSent',
      description: 'sent SMS bubble',
      light: {
        backgroundColor: 'rgb(29, 29, 32)',
        color: 'rgb(255, 255, 255)',
      },
      dark: {
        backgroundColor: 'rgb(29, 29, 32)',
        color: 'rgb(255, 255, 255)',
      },
    },
    {
      enabled: expanded.channelEmailCount > 0,
      key: 'email',
      description: 'email bubble',
      light: {
        backgroundColor: 'rgb(94, 87, 136)',
        color: 'rgb(255, 255, 255)',
      },
      dark: {
        backgroundColor: 'rgb(94, 87, 136)',
        color: 'rgb(255, 255, 255)',
      },
    },
  ]

  for (const expectation of expectations) {
    if (!expectation.enabled) continue
    for (const appearance of ['light', 'dark']) {
      const sample = expanded.colorSamples?.[appearance]?.[expectation.key]
      if (!sample) {
        failures.push(
          `${label}: missing computed ${appearance} color sample for ${expectation.description}`,
        )
        continue
      }
      const expected = expectation[appearance]
      for (const property of ['backgroundColor', 'color']) {
        if (sample[property] !== expected[property]) {
          failures.push(
            `${label}: ${expectation.description} ${appearance} ${property} ${sample[property]} should be ${expected[property]}`,
          )
        }
      }
    }
  }
}

function isIgnorableConsoleEntry(entry) {
  if (!/Failed to load resource/i.test(entry.text || '')) return false
  const url = entry.location?.url || ''
  return url ? !isAppNetworkUrl(url) : false
}

function isAppNetworkUrl(value) {
  try {
    const url = new URL(value)
    const appUrl = new URL(baseUrl)
    if (url.origin !== appUrl.origin) return false
    const appPath = appUrl.pathname.replace(/\/+$/, '') || '/'
    if (appPath === '/') return true
    return url.pathname === appPath || url.pathname.startsWith(`${appPath}/`)
  } catch {
    return true
  }
}

function isIgnorableRequestFailure(request, errorText) {
  if (!/ERR_ABORTED/.test(errorText || '')) return false
  if (request.method() === 'GET') return true
  try {
    const url = new URL(request.url())
    return (
      url.pathname.endsWith('/api/dialer-state') ||
      (shouldUseLocalActivityFixtureFallback() &&
        request.method() === 'POST' &&
        url.pathname.endsWith('/api/leads/bulk-delete'))
    )
  } catch {
    return false
  }
}

function shouldUseLocalActivityFixtureFallback() {
  try {
    const url = new URL(baseUrl)
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

function cssAttributeValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function loadActivityChannelExpectations(failures) {
  const result = {
    email: null,
    sms: null,
  }
  try {
    const threadsPayload = await fetch(`${baseUrl}/api/communication-threads?limit=120`).then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return response.json()
    })
    const threads = Array.isArray(threadsPayload?.threads) ? threadsPayload.threads : []
    for (const thread of threads) {
      const channels = Array.isArray(thread.channels) ? thread.channels : []
      if (!channels.includes('email') && !channels.includes('sms')) continue
      const messagesPayload = await fetch(
        `${baseUrl}/api/communication-threads/${encodeURIComponent(thread.threadId)}/messages?limit=120`,
      ).then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        return response.json()
      })
      const messages = Array.isArray(messagesPayload?.messages) ? messagesPayload.messages : []
      const emailMessages = messages.filter((message) => message.channel === 'email')
      const smsMessages = messages.filter((message) => message.channel === 'sms')
      const inboundEmail = emailMessages.filter(isInboundCommunicationMessage).length
      const inboundSms = smsMessages.filter(isInboundCommunicationMessage).length
      const outboundSms = smsMessages.filter(isOutboundCommunicationMessage).length
      if (!result.email && emailMessages.length > 0) {
        result.email = {
          threadId: thread.threadId,
          emailMessages: emailMessages.length,
          smsMessages: smsMessages.length,
          inboundEmail,
          inboundSms,
          outboundSms,
        }
      }
      if (!result.sms && smsMessages.length > 0) {
        result.sms = {
          threadId: thread.threadId,
          emailMessages: emailMessages.length,
          smsMessages: smsMessages.length,
          inboundEmail,
          inboundSms,
          outboundSms,
        }
      }
      if (result.email && result.sms) break
    }
  } catch (error) {
    failures.push(
      `library activity: failed to load production email/SMS expectations (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  return result
}

function isInboundCommunicationMessage(message) {
  return (
    message.direction === 'inbound' ||
    message.role === 'contact' ||
    message.role === 'user'
  )
}

function isOutboundCommunicationMessage(message) {
  return (
    message.direction === 'outbound' ||
    message.role === 'agent' ||
    message.role === 'operator'
  )
}
