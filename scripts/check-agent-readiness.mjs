import 'dotenv/config'
import fs from 'node:fs'
import {
  buildSpeakAgentContract,
  buildSpeakAgentReadinessReport,
} from '../server/agent-contract.mjs'

const publicBaseUrl =
  process.env.PUBLIC_BASE_URL || 'https://speak.example.com/speak'
const options = {
  basePath: process.env.BASE_PATH || '/speak',
  publicBaseUrl,
}

const contract = buildSpeakAgentContract(options)
const report = buildSpeakAgentReadinessReport(options)
const source = fs.readFileSync('src/uiContract.ts', 'utf8')
const failures = []
const expectedRouteLabels = {
  library: 'Library',
  dialer: 'Dialer',
  configs: 'Playground',
}

if (report.overallStatus !== 'pass') {
  failures.push(`readiness report status ${report.overallStatus}`)
}
report.checks
  .filter((check) => check.status !== 'pass')
  .forEach((check) => failures.push(`readiness check failed: ${check.id}`))

const sourceActionIds = extractConstObjectValues(source, 'speakActionIds')
const contractActionIds = contract.frontend.uiActions.map((action) => action.id)
compareSets('source action IDs', sourceActionIds, 'contract uiActions', contractActionIds)

const sourceRouteIds = extractConstObjectValues(source, 'speakRouteIds')
const contractRouteIds = contract.frontend.routes.map((route) => route.id)
compareSets('source route IDs', sourceRouteIds, 'contract frontend.routes', contractRouteIds)
contract.frontend.routes.forEach((route) => {
  const expectedLabel = expectedRouteLabels[route.id]
  if (!expectedLabel) {
    failures.push(`frontend.routes.${route.id} has no expected route label mapping`)
  } else if (route.label !== expectedLabel) {
    failures.push(`frontend.routes.${route.id} label ${route.label || '(missing)'} != ${expectedLabel}`)
  }
  validateFrontendRoute(route)
})

const sourceTestIds = extractConstObjectValues(source, 'speakTestIds')
const contractTestIds = collectContractTestIds(contract)
compareSets('source test IDs', sourceTestIds, 'contract automation test IDs', contractTestIds)

const backendActionIds = new Set(contract.backend.actions.map((action) => action.id))
contract.frontend.uiActions.forEach((uiAction) => {
  ;(uiAction.backendActions || []).forEach((backendAction) => {
    if (!backendActionIds.has(backendAction)) {
      failures.push(`${uiAction.id} references missing backend action ${backendAction}`)
    }
  })
  if (
    !(uiAction.backendActions || []).length &&
    !uiAction.headlessEquivalent &&
    !uiAction.proof?.length
  ) {
    failures.push(`${uiAction.id} lacks backend mapping, headlessEquivalent, and proof`)
  }
})

const generatedPayload = JSON.stringify({
  contract,
  report,
})
if (/HUME_API_KEY|INWORLD_API_KEY|\/evi\/(?:configs|chat|tools|language_models)|hume-session/.test(generatedPayload)) {
  failures.push('agent-facing generated contract leaks raw provider internals')
}

if (!contract.agentAdapters.a2aAgentCard || !contract.agentAdapters.a2aAgentJson) {
  failures.push('contract missing one or both A2A Agent Card discovery aliases')
}

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        failures,
        readiness: report.summary,
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
        readinessLevel: report.readinessLevel,
        checks: report.summary,
        uiActions: contractActionIds.length,
        testIds: contractTestIds.length,
        adapters: contract.generativeUi.adapters.map((adapter) => ({
          id: adapter.id,
          status: adapter.status,
        })),
      },
      null,
      2,
    ),
  )
}

function extractConstObjectValues(sourceText, exportName) {
  const match = sourceText.match(
    new RegExp(`export const ${exportName} = \\{([\\s\\S]*?)\\} as const`),
  )
  if (!match) {
    failures.push(`missing ${exportName} in src/uiContract.ts`)
    return []
  }
  return [...match[1].matchAll(/:\s*'([^']+)'/g)]
    .map((entry) => entry[1])
    .sort()
}

function collectContractTestIds(agentContract) {
  const ids = new Set(agentContract.frontend.automation.stableTestIds || [])
  agentContract.frontend.automation.routeContracts.forEach((route) => {
    ;[
      route.rootTestId,
      route.topbarTestId,
      ...(route.criticalTestIds || []),
      ...(route.desktopOnlyTestIds || []),
      ...(route.phoneOnlyTestIds || []),
    ]
      .filter(Boolean)
      .forEach((id) => ids.add(id))
  })
  agentContract.frontend.uiActions
    .map((action) => action.testId)
    .filter(Boolean)
    .forEach((id) => ids.add(id))
  return [...ids].sort()
}

function validateFrontendRoute(route) {
  const routeKey = `frontend.routes.${route.id || '(missing-id)'}`
  if (!route.path || !route.path.startsWith('/')) {
    failures.push(`${routeKey} path must be an absolute app path`)
  }
  const expectedUrl = route.path
    ? `${publicBaseUrl.replace(/\/+$/g, '')}${route.path}`
    : ''
  if (!route.url) {
    failures.push(`${routeKey} url is missing`)
  } else if (expectedUrl && route.url !== expectedUrl) {
    failures.push(`${routeKey} url ${route.url} != ${expectedUrl}`)
  }
  if (!route.purpose || route.purpose.length < 20) {
    failures.push(`${routeKey} purpose must describe the operator-facing route`)
  }
}

function compareSets(leftLabel, leftValues, rightLabel, rightValues) {
  const left = new Set(leftValues)
  const right = new Set(rightValues)
  const missingRight = [...left].filter((value) => !right.has(value))
  const missingLeft = [...right].filter((value) => !left.has(value))
  if (missingRight.length > 0) {
    failures.push(`${rightLabel} missing ${leftLabel}: ${missingRight.join(', ')}`)
  }
  if (missingLeft.length > 0) {
    failures.push(`${leftLabel} missing ${rightLabel}: ${missingLeft.join(', ')}`)
  }
}
