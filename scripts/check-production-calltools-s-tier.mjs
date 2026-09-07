import { existsSync, readFileSync } from 'node:fs'
import { buildSpeakAgentContract, buildSpeakAgentReadinessReport } from '../server/agent-contract.mjs'

const rawArgs = process.argv.slice(2)
const options = Object.fromEntries(
  rawArgs
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split('=')
      return [key, rest.join('=')]
    }),
)

const files = {
  packageJson: 'package.json',
  readme: 'README.md',
  agents: 'AGENTS.md',
  branding: 'BRANDING.md',
  docsHtml: 'docs/index.html',
  docsIndex: 'docs/index.md',
  uiContract: 'src/uiContract.ts',
  agentIntegration: 'docs/agent-integration.md',
  agentReference: 'docs/agent-reference.md',
  backendApi: 'docs/backend-api-reference.md',
  communicationThreads: 'docs/communication-thread-model.md',
  configuration: 'docs/configuration-options.md',
  generativeUiWidgets: 'docs/generative-ui-widgets.md',
  uiReference: 'docs/ui-reference.md',
  server: 'server/index.mjs',
  configurationTestPanel: 'src/ConfigurationTestPanel.tsx',
  configurationTestSession: 'src/useConfigurationTestSession.ts',
  agentConfigWorkspace: 'src/AgentConfigWorkspace.tsx',
  libraryWorkspace: 'src/LibraryWorkspace.tsx',
  leadWorkspaceHook: 'src/useLeadWorkspace.ts',
  leadBulkActionBar: 'src/LeadBulkActionBar.tsx',
  speakLogoMark: 'src/SpeakLogoMark.tsx',
  callAudio: 'server/call-audio.mjs',
  calltoolsClient: 'server/calltools-client.mjs',
  workspaceStore: 'server/workspace-store.mjs',
  agentContract: 'server/agent-contract.mjs',
  speakMcp: 'server/speak-mcp.mjs',
  mediaGatewayCheck: 'scripts/check-calltools-media-gateway.mjs',
  phoneAgentCheck: 'scripts/check-calltools-phone-agent.mjs',
  readinessCheck: 'scripts/check-calltools-readiness.mjs',
  liveProof: 'scripts/check-calltools-live-proof.mjs',
  contactProof: 'scripts/check-calltools-contact-proof.mjs',
  automatedProof: 'scripts/check-calltools-automated-proof.mjs',
  fullE2eAudit: 'scripts/check-full-e2e-audit.mjs',
  fullAuditCoverage: 'scripts/check-full-audit-coverage.mjs',
  backendApiCheck: 'scripts/check-backend-api-contract.mjs',
  agentSessionHelper: 'scripts/ensure-calltools-agent-session.mjs',
  mcpAppCheck: 'scripts/check-mcp-app.mjs',
  maintenanceSafety: 'scripts/check-maintenance-script-safety.mjs',
  brandMarketingCheck: 'scripts/check-brand-marketing.mjs',
  recordingTranscriptAudit: 'scripts/audit-calltools-recording-transcript.mjs',
  transcriptRenderingCheck: 'scripts/check-transcript-rendering.mjs',
  actionInvokeCheck: 'scripts/check-action-invoke.mjs',
  agentAdaptersCheck: 'scripts/check-agent-adapters.mjs',
  agentReadinessCheck: 'scripts/check-agent-readiness.mjs',
  hostClientCheck: 'scripts/check-host-client.mjs',
  uiContractCheck: 'scripts/check-ui-contract.mjs',
  operatorSkill: 'agent/skills/speak-operator/SKILL.md',
  operatorWorkflows: 'agent/skills/speak-operator/references/workflows.md',
  viteConfig: 'vite.config.ts',
  calltoolsRecordingTranscription: 'scripts/transcribe-calltools-recording.mjs',
  calltoolsAudioEvidence: 'scripts/calltools-audio-evidence.mjs',
  proofGates: 'scripts/calltools-proof-gates.mjs',
  calltoolsGateway: 'src/calltoolsGateway.ts',
  clientCalls: 'src/calls.ts',
}

const source = Object.fromEntries(
  Object.entries(files).map(([key, file]) => [key, read(file)]),
)
const packageJson = JSON.parse(source.packageJson)
const fullAuditDirectGateTokens = [
  'audit:calltools-recording-transcript',
  'build:speak',
  'calltools:agent-session',
  'lint',
  'qa:action-invoke',
  'qa:agent-adapters',
  'qa:agent-readiness',
  'qa:backend-api',
  'qa:brand-marketing',
  'qa:browser:check',
  'qa:calltools-live-proof',
  'qa:calltools-live-proof-contract',
  'qa:calltools-media-gateway',
  'qa:calltools-phone-agent',
  'qa:calltools-readiness',
  'qa:communication-threads',
  'qa:context-runtime',
  'qa:full-audit-coverage',
  'qa:host-client',
  'qa:inworld-latency',
  'qa:lead-identity',
  'qa:maintenance-safety',
  'qa:mcp-app',
  'qa:production-calltools-s-tier',
  'qa:session-prompt',
  'qa:source-import-merge',
  'qa:speak-icons',
  'qa:telnyx-source-routing',
  'qa:transcript-emotions',
  'qa:transcript-rendering',
  'qa:transport',
  'qa:ui-adapter-kit',
  'qa:ui-contract',
  'qa:ui-snapshot',
  'qa:speak-agent-tier',
  'qa:voice-configs',
  'qa:voice-provider-process',
  'qa:widget-bridge',
  'qa:workspace-email',
  'qa:workspace-email-source',
]
const liveProofPayload = readJsonFile(
  options.liveProof ||
    options.proof ||
    process.env.CALLTOOLS_S_TIER_LIVE_PROOF_JSON ||
    process.env.CALLTOOLS_PRODUCTION_LIVE_PROOF_JSON ||
    '',
)
const liveProofMaxAgeMs = nonNegativeNumber(
  options.liveProofMaxAgeMs ||
    process.env.SPEAK_FULL_AUDIT_LIVE_PROOF_MAX_AGE_MS ||
    process.env.CALLTOOLS_S_TIER_LIVE_PROOF_MAX_AGE_MS,
  60 * 60 * 1000,
)
const expectedCallToolsProfileId = String(
  options.profileId ||
    options.calltoolsProfileId ||
    process.env.CALLTOOLS_PROFILE_ID ||
    process.env.CALLTOOLS_GATEWAY_PROFILE_ID ||
    '',
).trim()
const contract = buildSpeakAgentContract({
  basePath: process.env.BASE_PATH || '/speak',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://speak.example.com/speak',
})
const readiness = buildSpeakAgentReadinessReport({
  basePath: process.env.BASE_PATH || '/speak',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://speak.example.com/speak',
})

const categories = [
  category('production-readiness', 18, [
    check('agent readiness is passing', readiness.overallStatus === 'pass'),
    check('agent readiness is S-class candidate', readiness.readinessLevel === 's-class-candidate'),
    check('agent readiness has no failed checks', readiness.summary?.failed === 0),
    check('contract has no known gaps', (contract.knownGaps || []).length === 0),
    check('production build uses /speak base guard',
      (scriptIncludes('build:speak', 'qa:build-base') ||
        (scriptIncludes('build:speak', 'npm run build') &&
          scriptIncludes('build', 'qa:build-base'))) &&
      countOccurrences(source.agents, '`scripts/check-build-base.mjs`:') === 1 &&
      includesAll(source.agents, [
        'Do not deploy `dist/` from plain `npm run build`',
        'paths break `calltools-gateway.html`',
        'site.webmanifest` start URL, scope',
        'current Speak product copy',
        'relative icon paths',
      ])),
    check('full audit has package-script coverage guard', scriptExists('qa:full-audit-coverage') &&
      includesAll(source.fullE2eAudit, ['qa:full-audit-coverage']) &&
      includesAll(source.fullAuditCoverage, [
        'speak.full-audit-coverage.v1',
        'docs-artifact-emitter',
        'docs-artifact-check',
        'maintenance-apply',
        'agent-manifest-emitter',
        'long-running-runtime',
      ])),
    check('public docs expose full-audit direct gates',
      includesAll(source.readme, fullAuditDirectGateTokens) &&
      includesAll(source.readme, [
        'Full-audit direct gates',
        'qa:full-audit -- --include-live` is campaign-follow orchestration',
        'speak.calltools.campaign-proof.v1',
        'CallTools non-live readiness preflight',
        'npm run qa:calltools-readiness -- --require-ready --pause-after-ready',
        'without browser automation or dashboard automation',
        'npm run qa:build-base',
        'npm run qa:backend-api -- --baseUrl=https://speak.example.com/speak --json',
      ]) &&
      includesAll(source.docsHtml, [
        'S-tier verification gates',
        'backend-only CallTools readiness',
        'npm run qa:calltools-readiness -- --require-ready --pause-after-ready',
        'agent contract quality',
        'npm run qa:speak-agent-tier',
        'icon-system continuity',
        'npm run qa:speak-icons',
        'production backend/API live contract checks',
        'npm run qa:backend-api -- --baseUrl=https://speak.example.com/speak --json',
      ]) &&
      includesAll(source.docsIndex, [
        'CallTools S-tier certification gate',
        'qa:production-calltools-s-tier',
        'CallTools non-live readiness preflight',
        'npm run qa:calltools-readiness -- --require-ready --pause-after-ready',
        'without browser automation or dashboard automation',
        'Production backend/API live contract gate',
        'npm run qa:backend-api -- --baseUrl=https://speak.example.com/speak --json',
        'current Source Of Truth gates below',
        'Agent contract quality gate',
        'Full-audit direct gates',
        'npm run qa:build-base',
      ]) &&
      includesAll(source.docsIndex, fullAuditDirectGateTokens) &&
      includesAll(source.docsIndex, [
        'CallTools native-campaign proof observer',
        'speak.calltools.campaign-proof.v1',
      ]) &&
      excludesAny(source.docsIndex, [
        'verification gates in `scripts/check-usbc-agent-tier.mjs`',
        'npm run qa:usb-c-agent-tier',
        'USB-C quality gate:',
      ]) &&
      includesAll(source.agents, [
        'scripts/check-inworld-latency-contract.mjs',
        'scripts/check-session-prompt.mjs',
        'scripts/check-lead-identity.mjs',
        'scripts/check-context-runtime.mjs',
        'scripts/check-source-import-merge.mjs',
        'scripts/check-build-base.mjs',
      ])),
    check('retired direct-proof entrypoints are documented as nonmutating failures', includesAll([
      source.agents,
      source.readme,
      source.configuration,
      source.backendApi,
    ].join('\n'), [
      'calltools_direct_proof_unsupported',
      'mutationPerformed=false',
      'speak.calltools.campaign-proof.v1',
      'campaign-follow',
    ]) && excludesAny([
      source.agents,
      source.readme,
      source.configuration,
      source.backendApi,
    ].join('\n'), [
      'Maintained CallTools contact proof uses a real proof contact',
      'Legacy compatibility answer-bot toggle',
    ])),
    check('full audit validates backend API/reference continuity', scriptExists('qa:backend-api') &&
      includesAll(source.fullE2eAudit, [
        'qa:backend-api',
        '--baseUrl',
        'localDevServerEnv',
        'env.PUBLIC_BASE_URL = renderedBaseUrl',
      ]) &&
      includesAll(source.viteConfig, [
        "'/speak/.well-known'",
        "path.replace(/^\\/speak\\/\\.well-known/, '/.well-known')",
        "'/speak/mcp'",
        "path.replace(/^\\/speak\\/mcp/, '/mcp')",
      ]) &&
      includesAll(read('scripts/check-backend-api-contract.mjs'), [
        'extractServerRoutes',
        'readFirstArgument',
        'serverRoutes.some',
        'liveAgentAdapterDrift',
        'liveFrontendDrift',
        'liveRouteCount',
        'liveUiActionCount',
        'well-known-speak-agent',
        'a2a-agent-card',
        'a2a-agent-json',
        'directory-style /api root',
        'validateSurfaceManifest',
        'expectedCanonicalUrl',
        'safeText(payload?.canonicalUrl) === expectedCanonicalUrl',
        'mcp-streamable-http-plain-get',
        'expectedStatus',
        'widget-html',
        'host-client',
      ]) &&
      includesAll(source.readme, [
        'npm run qa:backend-api',
        'http://127.0.0.1:8787/.well-known/speak-agent.json',
        'exact method/path route',
        'frontend route labels/UI-action text',
        'live capabilities',
        'live OpenAPI',
        'path/method/operationId readback',
        'every documented public agent/adapter manifest',
        'widget HTML',
        'host client',
      ]) &&
      includesAll(source.backendApi, [
        'npm run --silent qa:backend-api',
        'npm run --silent agent:acp',
        'exact method/path route registrations in `server/index.mjs`',
        'every documented public agent/adapter manifest',
        'widget HTML',
        'host client',
        'frontend route labels/UI-action text',
        'live capabilities',
        'OpenAPI',
        'path/method/operationId readback',
        'Well-known Speak capabilities',
        'Backend health',
        'A2A Agent Card',
        'A2A Agent JSON alias',
        'Portable agent and widget manifests',
        'api/agent/ui-adapter-kit.json',
        'api/agent/ui-snapshot.json',
        'api/agent/mcp-ui.json',
        'api/agent/json-render.json',
        'api/agent/copilotkit.json',
        'frontend.routes',
        'Library`, `Dialer`, and `Playground',
      ]) &&
      includesAll(source.agents, [
        'scripts/check-backend-api-contract.mjs',
        'frontend route labels/UI-action text',
        'agent-facing frontend manifests',
      ])),
    check('full audit verifies maintenance scripts are dry-run safe', scriptExists('qa:maintenance-safety') &&
      includesAll(source.fullE2eAudit, ['qa:maintenance-safety']) &&
      includesAll(source.maintenanceSafety, [
        'speak.maintenance-script-safety.v1',
        'dry-run-apply-pair',
        'oauth-helper',
        '--allow-automation',
      ])),
    check('full audit validates published product page brand drift', scriptExists('qa:brand-marketing') &&
      includesAll(source.fullE2eAudit, ['qa:brand-marketing']) &&
      includesAll(source.brandMarketingCheck, [
        'SPEAK_PRODUCT_PAGE_URL',
        'fetchPublishedProductPage',
        'requiredPublishedProductTokens',
        'requiredPublishedDocChecks',
        'checkedPublishedDocs',
        'verifyUniquePublishedDocChecks',
        'checkedPublishedDocCheckCoverage',
        'duplicate published docs check path',
        'missing published docs check path',
        'published docs check path has no matching docs Markdown file',
        "docsMarkdownPaths().filter((path) => path !== 'index.md')",
        'verifyDocScreenshots',
        'docScreenshots',
        'BLUEBUBBLES_SERVER_URL',
        'POST /api/personal-phone/contacts/sync',
        'CALLTOOLS_PHONE_CREDENTIALS_JSON',
        'CALLTOOLS_CAMPAIGN_PROOF_WAIT_MS',
        'CALLTOOLS_CAMPAIGN_PROOF_POLL_MS',
        'calltools_direct_start_disabled',
        'speak.calltools.campaign-proof.v1',
        'CALLTOOLS_S_TIER_LIVE_PROOF_JSON',
        'CALLTOOLS_PROVIDER_ARTIFACT_GRACE_MS',
        'CallTools non-live readiness preflight',
        'npm run qa:calltools-readiness -- --require-ready --pause-after-ready',
        '--pause-after-ready',
        'Backend/headless Available/Unavailable',
        'SPEAK_FULL_AUDIT_PRODUCTION_BASE_URL',
        'SPEAK_FULL_AUDIT_REMOTE_CWD',
        'SPEAK_FULL_AUDIT_LIVE_PROOF_DIR',
        'SPEAK_PRODUCT_PAGE_URL',
        'SPEAK_COMMUNICATION_BACKFILL_LIMIT',
        'WORKSPACE_EMAIL_THREAD_REPAIR_ACCOUNT',
        'npm run repair:workspace-email-thread-identity:apply',
        'Workspace email repair rows must remain contiguous table rows',
        'verifyDocumentedEnvironmentOptions',
        'checkedEnvironmentOptions',
        'missing documented environment option',
        'duplicate documented environment option',
        'duplicatedDocumentedEnvironmentRows',
        'documentedEnvironmentIgnoreReasons',
        'verifyDocumentationReferences',
        'checkedDocumentationReferences',
        'references missing package script',
        'references missing local file',
        'references missing local link',
        'verifyPublishedInternalLinks',
        'checkedPublishedLinks',
        'checkedPublishedAssets',
        'productionAppPublicAssets',
        'verifyProductionAppPublicAssets',
        'checkedProductionAppAssets',
        'verifyDocumentedPublicUrls',
        'checkedDocumentedPublicUrls',
        'documented public URL from',
        'returned an empty body',
        'checkedPublishedExternalImages',
        'verifyDocumentationExternalLinks',
        'checkedDocumentationExternalLinks',
        'documentation external link returned',
        'directory-style agent endpoint URL',
        'mcp-streamable-http-plain-get',
        'expectedStatus',
        'GenUI preview artifact is checked in but not documented',
        'documented GenUI preview artifact dimensions drifted',
        'verifyHereNowPublishRegistry',
        'checkedHereNowPublishes',
        '.herenow/state.json',
        'here.now docs missing required continuity token',
        'markdownSources',
        'published external image',
        'normalizePublishedProductHtmlSource',
        'cloudflareinsights',
        '.env.example',
        'VITE_API_PROXY_TARGET=http://127.0.0.1:8787',
        'INWORLD_TURN_EAGERNESS=high',
        'INWORLD_TTS_SEGMENTER_STRATEGY=full_turn',
        'INWORLD_RESPONSIVENESS_ENABLED=false',
        'INWORLD_OUTPUT_SAMPLE_RATE=16000',
        'CALLTOOLS_AGENT_SESSION_TIMEOUT_MS=180000',
        'CALLTOOLS_AGENT_SESSION_POLL_MS=5000',
        'stale CallTools dashboard session proof language',
        'stale HUME_CONFIG_ID all-live-call requirement',
        'baseline EVI settings',
        'POST /api/smart-config/turns/stream',
        'stale Smart Config turn endpoint',
        'stale MCP Playground widget text',
        'stale Playground test user-facing text',
        'stale browser-as-production-voice-proof wording',
        'stale mobile route order docs',
        'stale route-contract scope docs',
        'stale synthetic screenshot provenance',
        'public docs example.com placeholder URL',
        'public link to private Speak source repository',
        'Source repository: private `jacob-split/speak` workspace for maintainers',
        'api/agent/ui-adapter-kit.json',
        'api/agent/ui-snapshot.json?surface=configs',
        'src/SpeakLogoMark.tsx',
        'retired BrandIdentity wrapper',
        'retired BrandIdentity chrome CSS',
        'stale Voice and Persona Studio naming',
        'stale Library agent metric Config label',
        'stale CallTools lead-audio docs wording',
        'Backend Boundaries',
        'server/agent-action-invoker.mjs',
        'server/communication-automation.mjs',
        'server/telnyx-webhook-signature.mjs',
        'server/workspace-email-normalizer.mjs',
        'published product page contains blocked typography token',
        'normalized published product page HTML source drifted',
        'published docs missing required continuity token',
        'published docs raw Markdown source drifted',
        'published asset hash drifted',
        'production app public asset hash drifted',
        'failed to fetch published external image',
        'linked from published docs returned HTTP',
      ]) &&
      includesAll(source.readme, [
        'npm run qa:brand-marketing',
        'published product page',
        'checked-in screenshot manifest',
        'external integration icon images',
        'production app public assets',
        'current `.env.example` runtime defaults',
        'repo-local documentation package-script, file, and link references',
        'generated production route label/URL documentation',
        'documented public URL status/body checks',
        'accepts the documented MCP `406` plain-GET response',
        'docs/assets links',
        'public/` bytes',
        'normalized hosted product HTML source',
        'CDN-injected Cloudflare scripts',
        '.herenow/state.json',
        'https://onyx-breeze-jbke.here.now/',
        'https://serene-opera-92sg.here.now/',
        'https://timber-moment-pdae.here.now/',
      ]) &&
      includesAll(source.agents, [
        'custom-domain publish command uses here.now slug',
        'exhaustive published',
        'environment inventory',
        'documented public URL status/body checks',
        'public environment links',
        'additional live here.now mirrors',
        'continuity',
        'intentionally ignored by git',
      ]) &&
      includesAll(source.docsIndex, [
        'documented public URL status/body checks',
        'normalized hosted HTML/Markdown source parity',
        'generated production route label/URL documentation',
        'normalized hosted product HTML source',
        'accepts the documented MCP `406` plain-GET response',
        'fails on bad status or empty response bodies',
        'CDN-injected scripts',
        'Published Documentation Environments',
        'https://onyx-breeze-jbke.here.now/',
        'https://serene-opera-92sg.here.now/',
        'https://timber-moment-pdae.here.now/',
        'MCP Streamable HTTP',
        '`406 Not Acceptable`',
        '`text/event-stream`',
      ]) &&
      includesAll(source.configuration, [
        'CALLTOOLS_PHONE_CREDENTIALS_JSON',
        'CALLTOOLS_GATEWAY_PHONE_SERVER',
        'CALLTOOLS_AGENT_SESSION_TIMEOUT_MS',
        'CALLTOOLS_AGENT_SESSION_POLL_MS',
        'calltools_direct_start_disabled',
        'CALLTOOLS_CAMPAIGN_PROOF_WAIT_MS',
        'CALLTOOLS_CAMPAIGN_PROOF_POLL_MS',
        'qa:full-audit -- --include-live',
        'CALLTOOLS_LIVE_PROOF_MIN_CALLER_TURNS',
        'CALLTOOLS_S_TIER_LIVE_PROOF_JSON',
        'CALLTOOLS_PROVIDER_ARTIFACT_GRACE_MS',
        'SPEAK_FULL_AUDIT_PRODUCTION_BASE_URL',
        'SPEAK_FULL_AUDIT_SSH_HOST',
        'SPEAK_FULL_AUDIT_LIVE_PROOF_DIR',
        'SPEAK_PRODUCT_PAGE_URL',
        'SPEAK_COMMUNICATION_BACKFILL_LIMIT',
        'WORKSPACE_EMAIL_THREAD_REPAIR_ACCOUNT',
        'CALL_LOG_DIR',
        'VITE_API_PROXY_TARGET',
        'CALLTOOLS_GATEWAY_HEADLESS',
        'SPEAK_BASE_URL',
        'SPEAK_BACKEND_API_BASE_URL',
      ]) &&
      includesAll(source.speakLogoMark, [
        'speak-logo-mark.svg',
        'export function SpeakLogoMark',
      ]) &&
      !existsSync('src/BrandIdentity.tsx')),
    check('health/readiness docs name production URLs', includesAll(source.agents, [
      'Production app URL',
      'Backend health',
      'ChatGPT MCP app endpoint',
    ])),
    check('public docs expose generated production surface map',
      includesAll(source.docsIndex, [
        'Production Surface Map',
        contract.product.productionPlaygroundUrl,
        contract.product.productionHealthUrl,
        contract.frontend.routes.find((route) => route.id === 'library')?.url,
        contract.frontend.routes.find((route) => route.id === 'dialer')?.url,
        contract.agentAdapters.capabilities,
        contract.agentAdapters.wellKnownSpeakAgent,
        contract.agentAdapters.readiness,
        contract.agentAdapters.widgetHtml,
        'npm run --silent agent:ui-kit',
        'npm run --silent agent:ui-snapshot',
      ]) &&
      includesAll(source.readme, [
        contract.agentAdapters.capabilities,
        contract.agentAdapters.wellKnownSpeakAgent,
        contract.agentAdapters.openapi,
        contract.agentAdapters.acp,
        contract.agentAdapters.actionInvocation,
        contract.agentAdapters.chatgptApp,
        contract.agentAdapters.readiness,
        contract.agentAdapters.widgetHtml,
        contract.agentAdapters.hostClient,
        contract.agentAdapters.generativeUi,
        contract.agentAdapters.uiAdapterKit,
        contract.agentAdapters.uiSnapshot,
        contract.agentAdapters.mcpUi,
        contract.agentAdapters.agUi,
        contract.agentAdapters.a2ui,
        contract.agentAdapters.a2aAgentCard,
        contract.agentAdapters.a2aAgentJson,
        contract.agentAdapters.aiSdk,
        contract.agentAdapters.jsonRender,
        contract.agentAdapters.copilotKit,
      ]) &&
      includesAll(source.brandMarketingCheck, [
        'verifyDocumentedProductionSurfaces',
        'productionFrontendRouteSurfaces',
        'hasLabelNearUrl',
        'productionSurfaceUrls',
        'checkedProductionSurfaces',
        'production route label',
        'production surface missing from public docs home',
        'production surface missing from README public links',
      ]) &&
      productionRouteLabelsDocumented([
        source.readme,
        source.docsIndex,
        source.docsHtml,
      ])),
    check('docs do not present legacy campaign runner as current authority', includesAll(source.agents, [
      'legacy manual campaign runner',
      'not part of the production queue/campaign authority',
      'server-owned workspace/dialer state',
    ]) && includesAll(source.configuration, [
      'not wired into the current production dialer',
      'must not be used as queue/campaign authority',
      'passing `--check-leads` verification',
    ]) && includesAll(source.brandMarketingCheck, [
      'stale campaign-runner authority',
      'backend queue/campaign authority',
    ]) && excludesAny(source.agents, [
      '`server/campaign-runner.mjs`: backend queue/campaign authority',
    ])),
    check('profile sync docs are provider-neutral for Hume and Inworld', includesAll(source.agents, [
      'runtime-specific baseline settings',
      'Hume-backed profiles create or version Hume configs',
      'Inworld-backed profiles persist Speak-owned Inworld Realtime config/version proof',
      'Hume config sync must write that assembled backend prompt',
      'Inworld sync must return Speak-owned Realtime config/version proof',
    ]) && excludesAny(source.agents, [
      'baseline EVI settings',
      'future Hume-native and Codex CLM sessions',
    ]) && includesAll(source.speakMcp, [
      'productionPlaygroundUrl',
      'productionConfigUrl',
    ])),
  ]),
  category('live-engine-proof', 20, [
    check('actual CallTools live proof artifact is provided', Boolean(liveProofPayload)),
    check('live proof reports success', Boolean(liveProofPayload?.ok)),
    check('proof uses native campaign schema and invite identity', liveProofCampaignIdentity(liveProofPayload)),
    check('proof includes consistent call identity', liveProofIdentityConsistent(liveProofPayload)),
    check('proof artifact is recent enough for certification', liveProofFresh(liveProofPayload)),
    check('proof uses callee-first turn order', liveProofCalleeFirst(liveProofPayload)),
    check('proof includes enough two-sided conversation', liveProofTwoSided(liveProofPayload)),
    check('proof includes audible CallTools WAV-backed evidence', liveProofAudioEvidence(liveProofPayload)),
    check('proof embeds clean CallTools recording-derived transcript review', liveProofRecordingReviewClean(liveProofPayload)),
  ]),
  category('calltools-native-boundary', 14, [
    check('CallTools is modeled as dialer provider, not voice runtime', includesAll(source.agents, [
      'CallTools is a dialer/origination provider',
      'Do not route CallTools profiles',
      'through Telnyx',
    ])),
    check('direct CallTools starts fail before provider mutation', includesAll(source.server, [
      "app.post('/api/calls/start'",
      'resolveStartRuntimeConfig(config)',
      'isCallToolsDialer(runtimeConfig)',
      "code: 'calltools_direct_start_disabled'",
      'ensureVoiceProviderConfigReady(runtimeConfig)',
    ]) && callToolsDirectStartFailsBeforeVoiceReconciliation(source.server)),
    check('native campaign invites create the CallTools call state', includesAll(source.server, [
      "message.type === 'call.prepare'",
      'prepareCallToolsGatewayState',
      "dialerProvider: 'calltools'",
      "'calltools_gateway_invite_received'",
      'campaignFollow: true',
    ])),
    check('profile state stores non-secret binding only', includesAll(source.configuration, [
      'never put these values in profile state',
      'profile state still stores non-secret IDs only',
    ])),
    check('top-level readiness requires native campaign readiness', includesAll(source.calltoolsClient, [
      'const ready = runtimeReady && campaignReady',
      'runtimeBlockers',
      'campaignBlockers',
      'CallTools native campaign routing is ready',
    ]) && includesAll(source.readinessCheck, [
      'ready requires runtimeReady',
      'ready requires campaignReady',
      'campaignReady=false must expose campaignBlockers',
    ])),
    check('native CallTools backend agent session proof is required', includesAll(source.calltoolsClient, [
      'webPhoneRegisteredOn',
      'CALLTOOLS_AGENT_WEB_PHONE_NATIVE_SESSION_MISSING',
      'campaignAgentProof',
      'campaignagents_app_user_ready',
      'campaignLoginProof',
      'campaign_status_agent_counts',
      'ensureCallToolsAgentSessionReadiness',
      'CALLTOOLS_AGENT_SESSION_BACKEND_PROOF',
      "establishPath: 'agentstatuses.patch'",
      "'agentstatuses.read'",
      "'campaignagents.read'",
      "'campaignstatuses.read'",
    ]) && includesAll(source.readinessCheck, [
      'ensureCallToolsAgentSessionReadiness',
      'const ensureAgentSession',
      'pauseAfterReady',
      'agentSessionFinalPause',
      'args.baseUrl ||',
      'assertHeadlessReadinessVerifier',
      'shouldPollAfterAgentSessionEnsure',
      'result?.mutationPerformed',
      'CALLTOOLS_AGENT_STATUS_PATCH_FAILED',
      'native webPhoneRegisteredOn proof',
      'registered web phone without native session timestamp must be blocked',
      'agent-session proof must declare backendOnly=true',
      'agent-session proof must not require browser automation',
      'pause-after-ready must leave native AgentStatus not-ready after proving readiness',
      'readiness verifier must not depend on browser/dashboard automation',
      'api/calltools/agent-session',
      'confirmAgentSession',
    ]) && excludesAny(source.readinessCheck, [
      'prepareProofContact',
      'api/calltools/prepare-lead',
      'CALLTOOLS_PROOF_CONTACT_PHONE',
    ])),
    check('agent-session establishment is backend/headless-only', includesAll(source.agentSessionHelper, [
      'postAgentSession',
      'api/calltools/agent-session',
      'confirmAgentSession',
      'api/calltools/readiness',
      'backendOnly: true',
      'headlessOnly: true',
      'agentSessionBackendProofReady',
      'assertBackendHeadlessOnlyHelper',
      'forbiddenAutomationPatterns',
      'agentSessionNotReady',
      'targetReady',
      '--dry-run',
      '--ready=false',
      'CALLTOOLS_AGENT_SESSION_TIMEOUT_MS',
      'adoptResolvedCallToolsProfileId',
    ]) && excludesAny(source.agentSessionHelper, [
      'agent-config-calltools-default',
      'chromium',
      'playwright',
      'launchPersistentContext',
      'grantPermissions',
      '#username',
      '#password',
      'Join Campaign',
      'dashboardState',
      'CALLTOOLS_AGENT_SESSION_PASSWORD',
    ]) && includesAll(source.agents, [
      'backend/headless-only CallTools AgentStatus helper',
      'must not use browser automation or dashboard automation',
      'backend/headless-only `calltools:agent-session` helper',
    ]) && excludesAny([
      source.agents,
      source.readme,
      source.configuration,
      source.backendApi,
      source.uiReference,
    ].join('\n'), [
      'opens the real CallTools agent dashboard',
      'logs into the native dashboard',
      'dashboard/webphone session',
      '`Join Campaign` action',
      '--open --keep-open',
      'browser-held CallTools sessions',
    ]) && excludesAny(source.fullE2eAudit, [
      '--profileId=agent-config-calltools-default',
      '--keep-open',
      'calltoolsAgentSessionHeadless',
      'CALLTOOLS_AGENT_SESSION_HEADLESS',
    ])),
    check('normal operator scripts resolve the selected CallTools profile unless explicitly pinned',
      includesAll(source.agentSessionHelper, [
        "process.env.CALLTOOLS_GATEWAY_PROFILE_ID ||\n  ''",
        'adoptResolvedCallToolsProfileId',
      ]) && includesAll(source.readinessCheck, [
        "process.env.CALLTOOLS_GATEWAY_PROFILE_ID ||\n  ''",
        'adoptResolvedCallToolsProfileId',
      ]) && includesAll(source.fullE2eAudit, [
        'const calltoolsProfileId =',
        "...(calltoolsProfileId ? [`--profileId=${calltoolsProfileId}`] : [])",
      ]) && includesAll(source.liveProof, [
        'const expectedProfileId',
        'campaignProofIdentity',
      ]) && excludesAny([
        source.agentSessionHelper,
        source.readinessCheck,
        source.liveProof,
        source.fullE2eAudit,
      ].join('\n'), [
        'agent-config-calltools-default',
      ])),
    check('operator skill documents current CallTools campaign-follow sequence', includesAll(source.operatorSkill, [
      'CallTools campaign operation',
      'backend/headless `calltools:agent-session`',
      'observe the native campaign invite',
      'Never use `/api/calls/start` for a CallTools profile',
      'speak.calltools.campaign-proof.v1',
    ]) && includesAll(source.operatorWorkflows, [
      '## CallTools Campaign Following And Readiness',
      'CallTools remains the native contact-selection and dialing authority',
      'Go available',
      'No human dashboard login is required',
      'GET /api/calltools/readiness',
      'confirmAgentSession=true',
      'qa:calltools-readiness -- --require-ready --pause-after-ready',
      'qa:calltools-live-proof -- --require-complete --callControlId=<id>',
      'speak.calltools.campaign-proof.v1',
      'qa:full-audit -- --include-live',
    ])),
    check('CallTools readiness uses bounded backend API reads', includesAll(source.calltoolsClient, [
      'DEFAULT_CALLTOOLS_READINESS_REQUEST_TIMEOUT_MS',
      'CALLTOOLS_READINESS_REQUEST_TIMEOUT_MS',
      'const readinessRequest = callToolsReadinessRequestOptions()',
      'Promise.all',
      'readCallToolsAgentStatus(binding.appUserId || binding.userId, readinessRequest)',
      'CALLTOOLS_AGENT_STATUS_READ_FAILED',
      'CALLTOOLS_CAMPAIGN_AGENT_STATUS_READ_FAILED',
    ]) && includesAll(source.configuration, [
      'CALLTOOLS_READINESS_REQUEST_TIMEOUT_MS',
      'Readiness fans out native CallTools reads in parallel',
      'without browser automation or dashboard automation',
      'Backend/headless Available/Unavailable',
    ])),
  ]),
  category('gateway-and-latency', 16, [
    check('gateway uses SIP.js UserAgent registration', includesAll(source.calltoolsGateway, [
      'new UserAgent',
      'registerer',
      'gateway.heartbeat',
      'resetSyntheticLocalAudioForCall',
      'local_audio_outbound_stats',
      'outbound-rtp',
    ]) && includesAll(source.server, [
      'outboundRtp',
      'firstAudioRtpStats',
    ])),
    check('readiness rejects stale gateways', includesAll(source.server, [
      'CALLTOOLS_GATEWAY_STALE_AFTER_MS',
      'lastSeenAgeMs',
      'stale',
    ])),
    check('latency proof gates are enforced', includesAll(source.proofGates, [
      'calltoolsAttachToVoiceSession',
      'calltoolsInviteToVoiceInputReady',
      'firstUserMessageToFirstAssistantAudio',
      'calltoolsAttachToFirstAssistantAudio',
      'providerAudioToCallToolsOutput',
      'rawProviderClippedFrames',
      'finalOutputClippedFrames',
    ])),
    check('retired direct-proof entrypoints are minimal nonmutating guards',
      [source.contactProof, source.automatedProof].every((text) =>
        includesAll(text, [
          "schemaVersion: 'speak.calltools.direct-proof-unsupported.v1'",
          "error: 'calltools_direct_proof_unsupported'",
          'mutationPerformed: false',
          "supportedPath: 'native_campaign_invite'",
          'qa:calltools-live-proof',
        ]) &&
        text.split(/\r?\n/).length <= 20 &&
        excludesAny(text, [
          '/api/calls/start',
          '/api/calltools/prepare-lead',
          'VAPI_',
          'fetch(',
          'playwright',
        ]),
      )),
    check('local media gateway verifier exists', scriptExists('qa:calltools-media-gateway')),
  ]),
  category('campaign-library-sync', 11, [
    check('CallTools campaign contact sync API exists', includesAll(source.server, [
      '/api/calltools/campaign-contacts',
      'syncCallToolsCampaignContactsToWorkspace',
    ])),
    check('Library source is durable calltools contact source', includesAll(read('server/calltools-contacts.mjs'), [
      "source: 'calltools'",
      'importWorkspaceSourceLeads',
      'calltools://campaigns',
    ])),
    check('campaign selectable inventory is guarded', includesAll(source.phoneAgentCheck, [
      'source contacts directly',
      'live-filter contact selectability',
      'bucket contact selectability',
      'raw campaign-status selectable count',
    ]) && source.calltoolsClient.includes('CALLTOOLS_CAMPAIGN_NO_SELECTABLE_CONTACTS')),
  ]),
  category('recordings-and-transcripts', 18, [
    check('historical calls are read from native /calls API', includesAll(source.calltoolsClient, [
      'readCallToolsHistoricalCall',
      "callToolsRequest('/calls/'",
      'call_recording_fsfile_id',
    ])),
    check('historical recording lookup requires exact id or scoped fallback', includesAll(source.calltoolsClient, [
      'allowNewestFallback',
      'hasFallbackFilter',
      'callToolsHistoricalCallIdMatches',
      'callToolsHistoricalCandidatePool',
      'CALLTOOLS_HISTORICAL_CALL_START_TOLERANCE_MS',
    ]) && includesAll(source.phoneAgentCheck, [
      'rejects old recordings outside the start-time tolerance',
      'rejects stale contact/campaign recordings outside the start-time tolerance',
    ])),
    check('historical recording lookup supports gateway direct outbound calls', includesAll(source.calltoolsClient, [
      'destination',
      'app_user_id',
      'nearestCallToolsHistoricalCall',
      'dateOnly',
    ]) && includesAll(source.phoneAgentCheck, [
      'direct outbound lookup finds recording by app user, destination, and nearest start time',
    ])),
    check('CallTools recording fsfile id is persisted as provider link', includesAll(source.workspaceStore, [
      'calltoolsRecordingFsFileId',
      "kind: 'recording'",
    ])),
    check('CallTools native recording attachment coexists with local audio', includesAll(source.workspaceStore, [
      'attachmentListForCommunicationEvent',
      'communication.attachments',
      'event.audio',
    ])),
    check(
      'call end persists terminal state before bounded historical reconciliation',
      callToolsClosePersistsBeforeHistoricalLookup(source.server) &&
        includesAll(source.server, [
          'reconcileCallToolsHistoricalCallAfterClose',
          'CALLTOOLS_GATEWAY_CLOSE_RECONCILE_TIMEOUT_MS',
          'calltools_recording_reference_resolved',
          'callToolsCommunicationAttachments',
        ]),
    ),
    check('native recording references are reconciled after delayed provider availability', includesAll(source.server, [
      'CALLTOOLS_RECORDING_RECONCILE_DELAYS_MS',
      '600000,1800000,3600000',
      'scheduleCallToolsRecordingReconciliation',
      'CallTools recording ready',
    ])),
    check('communication-thread docs describe provider recordings', includesAll(source.communicationThreads, [
      'CallTools',
      'recordings',
      'providerLinks',
    ])),
    check('CallTools recording-derived audit uses Speak-generated transcript as primary comparison', scriptExists('audit:calltools-recording-transcript') &&
      includesAll(source.recordingTranscriptAudit, [
        'recordingTranscript',
        'CALLTOOLS_RECORDING_TRANSCRIPT_NEEDED',
        '--transcribeRecording',
        'downloadCallToolsFilesystemFile',
        'provider_recording_transcribed_by_speak',
        'LIVE_SPEAK_STT_CORRECTED_BY_PROVIDER_RECORDING',
        'SPEAK_TURNS_NOT_FOUND_IN_PROVIDER_RECORDING_TRANSCRIPT',
      ])),
    check('fresh CallTools recording lag is modeled as pending provider evidence', includesAll(source.recordingTranscriptAudit, [
      'CALLTOOLS_RECORDING_LAG_GRACE_MS',
      'clean_pending',
      'CALLTOOLS_RECORDING_REFERENCE_PENDING',
      'CALLTOOLS_RECORDING_REFERENCE_MISSING_FOR_TRANSCRIPT',
    ])),
    check('full audit validates supplied live proof with recording-derived transcript review instead of skipped coverage', includesAll(source.fullE2eAudit, [
      'supplied-live-proof',
      'validateSuppliedLiveProofArtifact',
      "schemaVersion === 'speak.calltools.campaign-proof.v1'",
      'campaign proof recording-derived transcript review failed',
      'payload.accepted !== true',
      'payload.nativeInviteReceived !== true',
      'payload.identity?.ok !== true',
      'replaySuppliedLiveProofArtifact',
      'liveProofArtifactAgeStatus',
      'startCallToolsRecordingTranscriptForLiveProof',
      'runCallToolsRecordingTranscriptForLiveProof',
      'calltoolsPreflightCommands',
      'if (requireCallToolsReady)',
      'calltools:agent-session',
      'const calltoolsReadinessCommand',
      'runCallToolsAgentSessionForAudit',
      'runCallToolsAgentSessionForAudit({ ready: true })',
      "--ready=${ready ? 'true' : 'false'}",
      '--apply',
      'backend AgentStatus ensured',
      'callToolsPreflightReady',
      'Native campaign proof was not awaited because campaign-follow availability/readiness preflight failed.',
      'CALLTOOLS_CAMPAIGN_PROOF_WAIT_MS',
      'runLiveProofGroup',
      '--startedAfter=',
      '--waitMs=',
      '--baseUrl=${productionBaseUrl}',
      'callToolsRecordingTranscriptComparisonReady',
      "recordingTranscript?.status === 'generated'",
      "generatedRecordingTranscript?.status === 'available'",
      'Boolean(payload?.ok)',
      '--require-clean',
      'recordingReference?.available',
      'recording-derived-transcript',
      'CALLTOOLS_FULL_AUDIT_RECORDING_TRANSCRIPT_WAIT_MS',
      'calltools-recording-transcript-review',
      'audit:calltools-recording-transcript',
      'proof-embedded-clean-review',
    ]) && excludesAny(source.fullE2eAudit, [
      'calltools:prepare-proof-contact',
      'qa:calltools-contact-proof',
      'CALLTOOLS_PROOF_CONTACT_PHONE',
      'vapiContact',
    ])),
    check('full audit exposes explicit live proof evidence in JSON payload', includesAll(source.fullE2eAudit, [
      'buildLiveProofInfo',
      'liveProof:',
      'mode:',
      'callControlId:',
      'generatedLiveProofPath',
    ])),
    check('full audit has strict certification mode for no-caveat runs', includesAll(source.fullE2eAudit, [
      'certificationRequired',
      'coverageMode',
      '--certify',
      'recordFailure',
      'Certification mode cannot use --skip-build',
      'Certification mode cannot use --skip-rendered-ui',
      'recording-derived transcript comparison must be complete',
      'Certification mode requires --include-live or --liveProof=<campaign-proof.json>',
      'Certification mode requires production provider routing checks',
    ]) && includesAll(source.readme, [
      'Use `--certify` for no-caveat release certification',
      '`coverageMode` is `regression`',
      '`certification` when `--certify` is active',
    ]) && includesAll(source.configuration, [
      'SPEAK_FULL_AUDIT_CERTIFY',
      'coverageMode=certification',
      'coverageMode=regression',
    ])),
    check('CallTools recording-derived utility generates the comparison transcript', scriptExists('calltools:transcribe-recording') &&
      includesAll(source.calltoolsRecordingTranscription, [
        '/stt/v1/transcribe',
        'INWORLD_API_KEY',
        'CALLTOOLS_RECORDING_STT_MODEL',
        'transcribeConfig',
        'audioData',
        'transcription?.transcript',
      ])),
    check('CallTools proof distinguishes transport packets from audible WAV evidence',
      scriptExists('qa:calltools-live-proof-contract') &&
      includesAll(source.fullE2eAudit, [
        'qa:calltools-live-proof-contract',
      ]) && includesAll(source.liveProof, [
        'callerAudioTransport',
        'callerAudioAudible',
        'assistantAudioTransport',
        'assistantAudioAudible',
        'Boolean(leadAudio?.audible)',
        'Boolean(aiAudio?.audible)',
        'leadCallToolsInput',
        'aiCallToolsOutput',
        'audioStatsSummary',
        'conversationalTurn',
        '!greetingRequested',
        'agentWaitedForCaller',
        'enoughBackAndForth',
        'assistantTranscriptAfterCaller',
    ]) && includesAll(source.liveProof, [
      "schemaVersion: 'speak.calltools.campaign-proof.v1'",
      'nativeInviteReceived',
      'campaignProofIdentity',
      'minCallerTurns',
      'minAssistantTurns',
      'recordingTranscriptReview',
    ]) && includesAll(source.calltoolsAudioEvidence, [
      'analyzeWavFile',
      'activeRatio',
      'audible',
    ]) && includesAll(source.server, [
      'conversation.item.added',
      'conversation.item.done',
    ]) && includesAll(source.configuration, [
      'legacy-named `firstCallToolsLeadAudioToFirstUserMessage` caller-audio-to-user-message timing',
    ]) && includesAll(source.readme, [
      'legacy-named',
      '`firstCallToolsLeadAudioToFirstUserMessage` for caller/contact audio',
    ]) && includesAll(source.backendApi, [
      'legacy-named `firstCallToolsLeadAudioToFirstUserMessage` for',
      'caller/contact audio',
    ])),
    check('CallTools native-campaign proof observer is exposed in full audit', includesAll(source.packageJson, [
      'qa:calltools-live-proof',
    ]) && includesAll(read('scripts/check-full-e2e-audit.mjs'), [
      'qa:calltools-live-proof',
      'live-proof-gated',
      'runLiveProofGroup',
      '--startedAfter=',
    ])),
    check('transcript rendering duplicate guard is required by S-tier and full audit', scriptExists('qa:transcript-rendering') &&
      includesAll(source.transcriptRenderingCheck, [
        'duplicateTranscriptGroups',
        'scanApiTranscripts',
        'inworld-duplicate-provider-event',
      ]) &&
      includesAll(read('scripts/check-full-e2e-audit.mjs'), [
        'qa:transcript-rendering',
        'productionBaseUrl',
      ]) &&
      includesAll(source.clientCalls, [
        'incoming.providerEventId',
        'existingProviderIndex',
      ])),
  ]),
  category('operator-experience', 10, [
    check('Dialer uses live transcript and events pane contract', includesAll(source.agents, [
      'Watch live transcripts and call state',
      'transcript panel',
      'While the dialer is running',
    ])),
    check('Activity and Library use unified transcript renderer rules', includesAll(source.agents, [
      'same shared transcript bubble body',
      'provider-specific per-turn metadata',
      'Providers that do not emit scores must simply omit',
      'email/SMS communication threads',
      'Global Search, widgets, and agent contracts',
      'first-class proof surfaces',
      'src/GlobalSearchOverlay.tsx`: shared indexed search over contacts, communication threads, transcripts, profiles, and Smart Views',
    ]) && includesAll(source.branding, [
      'Global search icon for contacts, communication threads, transcripts, profiles, and Smart Views',
    ]) && includesAll(source.uiContractCheck, [
      'loadActivityChannelExpectations',
      'library-activity-email',
      'library-activity-sms',
      'receivedSmsCount',
      'sentSmsCount',
    ]) && includesAll(source.communicationThreads, [
      'thread-aware views: Library Activity',
      'Global Search indexes communication',
      'MCP widgets and agent contracts expose communication-thread summaries',
      'message reads as first-class proof surfaces',
    ]) && !/future one-pane conversation|one-pane chat does not exist yet|unified conversation pane exists|one-pane contact conversation UI|current production readback uses recent call\/config-test history/i.test([
      source.communicationThreads,
      source.readme,
      source.agents,
      source.agentIntegration,
    ].join('\n')) && !/one-pane contact (?:chat|conversation) work/i.test([
      source.agents,
      source.agentIntegration,
    ].join('\n'))),
    check('UI reference maps CallTools settings and readiness', includesAll(source.uiReference, [
      'CallTools controls bind user',
      'Readiness reports exact blockers',
    ])),
    check('Dialer docs do not claim a retired operator-chat panel', includesAll(source.agents, [
      'Do not document or reintroduce a separate Dialer operator-chat toggle/composer',
      '/api/calls/{callControlId}/instructions',
      '/api/operator-chat/turns',
      'not a separate Dialer transcript panel',
    ]) && includesAll(source.uiReference, [
      'Agent Whisper/live guidance',
      'not a separate Dialer chat panel',
    ]) && excludesAny([
      source.agents,
      source.branding,
      source.uiReference,
    ].join('\n'), [
      'transcript message icon toggles',
      'Transcript/chat panel',
    ])),
    check('frontend action contract does not expose retired Dialer agent chat', !contract.frontend?.uiActions?.some((action) =>
      action.id === 'open_agent_chat',
    ) && !source.uiContract.includes("openAgentChat: 'open_agent_chat'") && contract.backend?.actions?.some((action) =>
      action.id === 'send_operator_chat_message',
    )),
    check('frontend action contract uses rendered profile selector only', !contract.frontend?.uiActions?.some((action) =>
      ['use_profile', 'set_active_profile'].includes(action.id),
    ) && !source.uiContract.includes("useProfile: 'use_profile'") &&
      !source.uiContract.includes("setActiveProfile: 'set_active_profile'") &&
      contract.frontend?.uiActions?.some((action) =>
        action.id === 'select_agent_profile' &&
        action.backendActions?.includes('set_active_profile'),
      ) &&
      contract.backend?.actions?.some((action) => action.id === 'set_active_profile')),
    check('frontend action contract exposes only rendered CSV import control', !contract.frontend?.uiActions?.some((action) =>
      action.id === 'import_csv',
    ) && !source.uiContract.includes("importCsv: 'import_csv'") &&
      !source.leadWorkspaceHook.includes('handleCsvUpload') &&
      contract.frontend?.uiActions?.some((action) =>
        action.id === 'import_smart_view_csv' &&
        action.surface === 'library' &&
        action.backendActions?.includes('import_smart_view_leads'),
      ) &&
      contract.backend?.actions?.some((action) => action.id === 'import_leads') &&
      contract.backend?.actions?.some((action) => action.id === 'import_smart_view_leads') &&
      includesAll(source.libraryWorkspace, [
        'data-action-id={speakActionIds.importSmartViewCsv}',
        "apiUrl('/smart-views/import')",
      ]) &&
      includesAll(source.uiReference, [
        '`POST /api/smart-views/import`',
        '`POST /api/leads/import` remains available for headless contact-import adapters',
      ])),
    check('profile and bulk selection actions expose stable rendered IDs', includesAll(source.agentConfigWorkspace, [
      'data-action-id={speakActionIds.copyProfile}',
      'data-action-id={speakActionIds.deleteProfile}',
      'data-action-id={speakActionIds.clearSelection}',
    ]) && includesAll(source.leadBulkActionBar, [
      'data-action-id={hasSelection ? speakActionIds.clearSelection : speakActionIds.selectLead}',
    ])),
  ]),
  category('agent-and-api-contracts', 9, [
    check('agent contract exposes CallTools readiness', contract.backend?.actions?.some((action) => action.id === 'read_calltools_readiness')),
    check('agent contract exposes backend CallTools agent-session establishment', contract.backend?.actions?.some((action) =>
      action.id === 'establish_calltools_agent_session' &&
      action.path === '/api/calltools/agent-session' &&
      action.callableByMcp === false,
    )),
    check('backend API reference documents CallTools audio proof', includesAll(source.backendApi, [
      'qa:calltools-live-proof',
      'speak.calltools.campaign-proof.v1',
      'assistant audio',
      'audio-quality gates',
    ])),
    check('backend API reference documents agent readiness schema', includesAll(source.backendApi, [
      'speak.agent-readiness.v1',
      'readinessLevel=s-class-candidate',
      'overallStatus=pass',
      'summary.failed=0',
    ])),
    check('backend API reference documents MCP transport behavior', includesAll(source.backendApi, [
      'MCP Streamable HTTP',
      '`406 Not Acceptable`',
      '`text/event-stream`',
    ]) && includesAll(read('scripts/check-backend-api-contract.mjs'), [
      'mcp-streamable-http-plain-get',
      'expectedStatus',
    ])),
    check('agent readiness verifies frontend route URLs and purposes', includesAll(source.agentReadinessCheck, [
      'validateFrontendRoute',
      'frontend.routes.${route.id ||',
      'path must be an absolute app path',
      'url is missing',
      'purpose must describe the operator-facing route',
    ]) && includesAll(source.backendApi, [
      'frontend.routes',
      'operator-facing labels, paths, public URLs, and purposes',
    ])),
    check('project manual lists every global adapter manifest', includesAll(source.agents, [
      'Global adapter manifests',
      'npm run --silent agent:app',
      '/.well-known/speak-agent.json',
      '/api/agent/generative-ui.json',
      '/api/agent/ui-adapter-kit.json',
      '/api/agent/ui-snapshot.json',
      '/api/agent/mcp-ui.json',
      '/api/agent/ag-ui.json',
      '/api/agent/a2ui.json',
      '/.well-known/agent-card.json',
      '/.well-known/agent.json',
      '/api/agent/ai-sdk.json',
      '/api/agent/json-render.json',
      '/api/agent/copilotkit.json',
    ])),
    check('agent integration guide starts from current adapter discovery', includesAll(source.agentIntegration, [
      'api/agent/chatgpt-app.json',
      'api/agent/readiness.json',
      'api/agent/generative-ui.json',
      'api/agent/ui-adapter-kit.json',
      'api/agent/ui-snapshot.json?surface=library',
      'api/agent/ui-snapshot.json?surface=dialer',
      'api/agent/ui-snapshot.json?surface=configs',
      'api/agent/mcp-ui.json',
      'api/agent/ag-ui.json',
      'api/agent/a2ui.json',
      'api/agent/ai-sdk.json',
      'api/agent/json-render.json',
      'api/agent/copilotkit.json',
      'api/agent/widgets/speak-operator.html',
      'api/agent/host-client.mjs',
      'https://speak.example.com/speak/api/health',
      'https://speak.example.com/speak/mcp',
      'https://speak.example.com/speak/configs',
      'https://speak.example.com/speak/api/agent/actions/{actionId}/invoke',
      'MCP Streamable HTTP',
      '`406 Not Acceptable`',
      '`text/event-stream`',
      '`/speak/mcp` render tools',
      'npm run --silent agent:acp',
      'npm run --silent agent:genui',
      'thread-aware contact conversation work',
      'npm run --silent agent:ui-kit',
      'npm run --silent agent:ui-snapshot',
      'npm run qa:agent-adapters',
      'npm run qa:ui-adapter-kit',
      'npm run qa:ui-snapshot',
    ])),
    check('host client docs use current client API', includesAll(source.hostClientCheck, [
      'documentedHostClientExamples',
      "createSpeakAgentClient({ baseUrl: '/speak' })",
      "baseUrl: 'https://speak.example.com/speak'",
      "client.hydrateWidget('#speak-widget'",
      "client.connectWidget('#speak-widget')",
      "client.invoke('read_workspace')",
      "client.hydrateSpeakWidget(",
      'README.md',
      'agent/skills/speak-operator/references/workflows.md',
      'apiRoot:',
      'widgetOrigin:',
    ]) && includesAll(source.agentIntegration, [
      "createSpeakAgentClient({ baseUrl: '/speak' })",
      "client.hydrateWidget('#speak-widget'",
      "client.connectWidget('#speak-widget')",
      'widget-originated tool calls',
    ]) && includesAll(source.backendApi, [
      "baseUrl: 'https://speak.example.com/speak'",
      "client.hydrateWidget('#speak-widget'",
      "client.connectWidget('#speak-widget')",
    ]) && excludesAny(`${source.agentIntegration}\n${source.backendApi}`, [
      'apiRoot:',
      'widgetOrigin:',
      'client.hydrateSpeakWidget(',
    ])),
    check('agent reference source of truth includes generated UI emitters', includesAll(source.agentReference, [
      'npm run --silent agent:genui',
      'npm run --silent agent:ui-kit',
      'npm run --silent agent:ui-snapshot',
      'MCP Streamable HTTP',
      '`406 Not Acceptable`',
      '`text/event-stream`',
      'speak.agent-readiness.v1',
      'readinessLevel=s-class-candidate',
      'overallStatus=pass',
      'readinessLevel=needs-work',
      '/api/agent/generative-ui.json',
      '/api/agent/ui-adapter-kit.json',
      '/api/agent/ui-snapshot.json?surface=library|dialer|configs',
      'published-surface changes',
      '.herenow/state.json',
      'npm run qa:brand-marketing',
      'npm run qa:backend-api -- --baseUrl=https://speak.example.com/speak --json',
      'npm run qa:full-audit',
      'npm run qa:production-calltools-s-tier -- --liveProof=',
      'npm run qa:speak-agent-tier',
    ]) && excludesAny(source.agentReference, [
      'Run the USB-C gate after contract, adapter, context, or documentation changes:',
      'npm run qa:usb-c-agent-tier',
    ])),
    check('backend API gate rejects stale agent contract versions',
      /^\s*export const SPEAK_AGENT_CONTRACT_VERSION = '\d{4}-\d{2}-\d{2}'/m.test(source.agentContract) &&
      includesAll(source.backendApiCheck, [
        'latestGitCommitDate',
        'agentContractLatestCommitDate',
        'server/agent-contract.mjs',
        'contractVersionMatches',
        'contractVersionDetails',
        'agent contract version',
        'older than latest committed agent-contract date',
      ])),
    check('MCP action surface includes CallTools campaign sync', contract.backend?.actions?.some((action) => action.id === 'sync_calltools_campaign_contacts')),
    check('MCP search/fetch exposes recent-call compatibility proof', includesAll(source.speakMcp, [
      "apiJson(apiRoot, '/calls/recent?limit=500')",
      'id: `call:${call.callControlId}`',
      "metadata: { type: 'recentCall'",
      '#transcript=${encodeURIComponent(call.callControlId)}',
    ]) && includesAll(source.mcpAppCheck, [
      'search did not return recent call result',
      'fetch did not identify call: result as recentCall',
      'MCP search must hydrate the same bounded recent-call window as call fetch',
    ])),
    check('action invocation guard sweeps every callable REST action', includesAll(source.actionInvokeCheck, [
      'callableRestAgentActions',
      'all-callable action invocation sweep',
      'sampleActionInvocationInput',
      'did not return every declared proof field',
      'contract.actionInvocation.callableActionCount',
    ])),
    check('agent integration docs use direct action envelope', includesAll(source.actionInvokeCheck, [
      'agent integration action-invocation example must wrap bulk status args in body.ids',
      'agent integration update_lead example must use path/body action envelope',
      'agent integration action-invocation example must not use stale direct leadIds convenience args',
      'Direct `fetch` callers must send the explicit action envelope',
    ]) && includesAll(source.agentIntegration, [
      'Direct `fetch` callers must send the explicit action envelope',
      "speakInvoke('bulk_update_lead_status'",
      "body: {\n    ids: ['lead-orion', 'lead-northline']",
      "speakInvoke('update_lead'",
      "path: { leadId: 'lead-orion' }",
    ]) && excludesAny(source.agentIntegration, [
      'leadIds: [',
      'console.log(result.updated)',
    ])),
    check('agent adapter guard preserves current Playground contract scope', includesAll(source.agentAdaptersCheck, [
      'phone-quality tests',
      'owner Smart Config',
      'Render Speak Playground widget',
      'productionPlaygroundUrl',
    ]) &&
      contract.product?.productionPlaygroundUrl?.endsWith('/configs') &&
      contract.frontend?.routes?.some((route) =>
        route.id === 'configs' &&
        /phone-quality tests/.test(route.purpose || '') &&
        /owner Smart Config/.test(route.purpose || ''),
      ) &&
      contract.chatgptApp?.renderTools?.some((tool) =>
        tool.id === 'render_speak_configs' &&
        tool.title === 'Render Speak Playground widget' &&
        /phone-quality tests/.test(tool.description || '') &&
        /owner Smart Config/.test(tool.description || ''),
      )),
    check('MCP and agent contract use current Playground wording', includesAll(source.agentContract, [
      'Start a browser Speak Playground test',
      'Start a real phone Playground test',
      'Browser Playground tests never place phone calls',
      'Render the Speak dialer or Playground widget',
      'Render Speak Playground widget',
    ]) && includesAll(source.speakMcp, [
      'Rendered Speak Playground widget',
      '<h2>Agent profile</h2>',
      "routeLabels = { library: 'Library', dialer: 'Dialer', configs: 'Playground' }",
    ]) && includesAll(source.server, [
      'Playground test started.',
      'Playground test ended.',
      'browser Playground test',
      'Speak Playground browser test',
    ]) && includesAll(source.configurationTestPanel, [
      'Stop Playground test',
      'Starting Playground test',
      'Start Playground test',
    ]) && includesAll(source.configurationTestSession, [
      'Starting Playground test...',
      'Playground test failed to start',
      'Playground test audio failed',
      'Playground test failed',
    ])),
    check('generative UI docs require live adapter verification', includesAll(source.generativeUiWidgets, [
      'npm run qa:widget-bridge',
      'npm run qa:ui-adapter-kit',
      'npm run qa:ui-snapshot',
      'npm run qa:backend-api -- --baseUrl=https://speak.example.com/speak --json',
      'npm run qa:host-client',
      'npm run qa:agent-adapters',
      'every documented public agent/adapter manifest',
      'widget HTML',
      'host client endpoint',
    ])),
  ]),
  category('redundancy-and-fail-closed', 5, [
    check('CallTools outcome writeback is proof-only by default', includesAll(source.configuration, [
      'CALLTOOLS_SYNC_OUTCOMES',
      'false',
      'proof-only',
    ])),
    check('obsolete Vapi and QA answer-bot production surfaces are removed', excludesAny([
      source.server,
      source.calltoolsGateway,
      source.configuration,
      source.backendApi,
      source.packageJson,
    ].join('\n'), [
      'VAPI_',
      'vapiContact',
      '/api/calltools/qa-answer-bot',
      '/api/calltools/qa-answer-gateway-config',
      'calltools:answer-phone',
      'CALLTOOLS_QA_ANSWER_',
    ])),
    check('campaign proof observer fails closed without a native invite', includesAll(source.liveProof, [
      'native_campaign_call_artifact_not_found',
      'native_campaign_call_proof_incomplete',
      'No lease-authorized native CallTools campaign invite matched this proof run.',
      'campaignProofIdentity',
      "schemaVersion: 'speak.calltools.campaign-proof.v1'",
    ]) && excludesAny(source.liveProof, [
      '/api/calls/start',
      '/api/calltools/prepare-lead',
      'fetch(',
      'VAPI_',
    ])),
    check('recording strategy avoids duplicated transcript storage', includesAll(source.agents, [
      'without duplicating transcript storage',
      'retrieved from Speak-owned persisted call logs',
    ])),
    check('CallTools comparison transcript is Speak-generated from recording audio', includesAll(source.agents, [
      'No CallTools text artifact is',
      'always Speak-generated from CallTools recording audio',
      'recording-derived transcript is recording-audio evidence',
    ]) && includesAll(source.readme, [
      'recording-derived transcript Speak',
      'No CallTools text artifact is',
      'comparison',
      'transcript is always created by Speak from CallTools recording audio',
    ]) && noCallToolsTextTranscriptDependency([
      source.readme,
      source.agents,
      source.backendApi,
      source.communicationThreads,
      source.configuration,
      source.fullE2eAudit,
      source.recordingTranscriptAudit,
      source.calltoolsRecordingTranscription,
    ].join('\n'))),
  ]),
]

const score = categories.reduce((total, item) => total + item.awarded, 0)
const maxScore = categories.reduce((total, item) => total + item.points, 0)
const normalizedScore = Math.round((score / maxScore) * 1000) / 10
const failures = categories.flatMap((item) =>
  item.checks.filter((check) => !check.ok).map((check) => `${item.name}: ${check.name}`),
)

const payload = {
  ok: failures.length === 0 && normalizedScore >= 99,
  score: normalizedScore,
  grade: normalizedScore >= 99 ? 'S-tier' : normalizedScore >= 90 ? 'A' : 'Needs work',
  maxScore: 100,
  categories: categories.map(({ name, points, awarded, checks }) => ({
    name,
    points,
    awarded,
    checks,
  })),
  failures,
  liveProof: liveProofPayload
    ? {
        source: options.liveProof || options.proof || process.env.CALLTOOLS_S_TIER_LIVE_PROOF_JSON || '',
        ok: Boolean(liveProofPayload.ok),
      }
    : {
        source: '',
        ok: false,
        required: true,
        hint:
          'Run qa:calltools-live-proof for a completed native campaign call and pass its JSON output with --liveProof=<file>.',
      },
}

if (!payload.ok) {
  console.error(JSON.stringify(payload, null, 2))
  process.exit(1)
}

console.log(JSON.stringify(payload, null, 2))

function category(name, points, checks) {
  const passed = checks.filter((item) => item.ok).length
  const awarded = checks.length ? points * (passed / checks.length) : points
  return {
    name,
    points,
    awarded,
    checks,
  }
}

function check(name, ok) {
  return { name, ok: Boolean(ok) }
}

function scriptExists(name) {
  return Boolean(packageJson.scripts?.[name])
}

function scriptIncludes(name, text) {
  return String(packageJson.scripts?.[name] || '').includes(text)
}

function includesAll(text, needles) {
  return needles.every((needle) => text.includes(needle))
}

function callToolsClosePersistsBeforeHistoricalLookup(text) {
  const start = text.indexOf('async function handleCallToolsGatewayClose')
  const end = text.indexOf("humanAudioWss.on('connection'", start)
  if (start < 0 || end <= start) return false
  const closeBlock = text.slice(start, end)
  const persistIndex = closeBlock.indexOf('persistCallOutcome(state, state.outcome)')
  const emitIndex = closeBlock.indexOf('emitCallEvent(state.callControlId')
  const reconcileIndex = closeBlock.indexOf('reconcileCallToolsHistoricalCallAfterClose(state)')
  return Boolean(
    persistIndex >= 0 &&
      emitIndex >= 0 &&
      reconcileIndex > persistIndex &&
      reconcileIndex > emitIndex &&
      !closeBlock.includes('await refreshCallToolsHistoricalCallForState'),
  )
}

function callToolsDirectStartFailsBeforeVoiceReconciliation(text) {
  const start = text.indexOf("app.post('/api/calls/start'")
  const end = text.indexOf("app.post('/api/calls/", start + 1)
  if (start < 0) return false
  const route = text.slice(start, end > start ? end : undefined)
  const rejection = route.indexOf("code: 'calltools_direct_start_disabled'")
  const reconciliation = route.indexOf('ensureVoiceProviderConfigReady(runtimeConfig)')
  return rejection >= 0 && reconciliation > rejection
}

function productionRouteLabelsDocumented(texts) {
  return (contract.frontend?.routes || []).every((route) =>
    texts.every((text) => hasLabelNearUrl(text, route.label || route.id, route.url)),
  )
}

function hasLabelNearUrl(text, label, url) {
  if (!label || !url) return false
  const index = text.indexOf(url)
  if (index === -1) return false
  const context = text.slice(Math.max(0, index - 160), Math.min(text.length, index + url.length + 160))
  return context.includes(label)
}

function excludesAny(text, needles) {
  return needles.every((needle) => !text.includes(needle))
}

function countOccurrences(text, needle) {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while (true) {
    const index = text.indexOf(needle, offset)
    if (index === -1) return count
    count += 1
    offset = index + needle.length
  }
}

function noCallToolsTextTranscriptDependency(text) {
  const forbidden = [
    ['call', 'transcripts'],
    ['fallback', ' transcript'],
    ['transcript', ' fallback'],
    ['transcribe', 'Fallback'],
    ['native', ' CallTools', ' transcript'],
    ['CallTools', '-generated', ' transcript'],
    ['CallTools', '-supplied', ' transcript'],
    ['prefer', ' native'],
  ].map((parts) => parts.join(''))
  const lower = String(text || '').toLowerCase()
  return forbidden.every((needle) => !lower.includes(String(needle).toLowerCase()))
}

function read(file) {
  if (!existsSync(file)) return ''
  return readFileSync(file, 'utf8')
}

function readJsonFile(file) {
  if (!file || !existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function liveProofSubject(payload) {
  if (!payload || typeof payload !== 'object') return null
  return payload.calltools && typeof payload.calltools === 'object'
    ? payload.calltools
    : payload
}

function liveProofIdentityConsistent(payload) {
  if (!payload || typeof payload !== 'object') return false
  if (payload.schemaVersion !== 'speak.calltools.campaign-proof.v1') return false
  const callControlId = liveProofCallControlId(payload)
  const proof = liveProofSubject(payload)
  if (!callControlId || proof?.callControlId !== callControlId) return false
  if (payload.identity?.ok !== true) return false
  if (
    expectedCallToolsProfileId &&
    payload.identity?.profileId !== expectedCallToolsProfileId
  ) return false
  return true
}

function liveProofCampaignIdentity(payload) {
  return Boolean(
    payload?.schemaVersion === 'speak.calltools.campaign-proof.v1' &&
      payload?.accepted === true &&
      payload?.nativeInviteReceived === true &&
      payload?.nativeGatewayAttached === true &&
      payload?.answered === true &&
      payload?.identity?.ok === true &&
      payload?.identity?.authoritative === true &&
      payload?.identity?.provider === 'calltools' &&
      payload?.identity?.leaseId &&
      payload?.identity?.profileId &&
      payload?.identity?.appUserId &&
      payload?.identity?.campaignId &&
      payload?.identity?.phoneId &&
      payload?.identity?.providerCallId &&
      Number.isFinite(Date.parse(payload?.identity?.verifiedAt || '')),
  )
}

function liveProofFresh(payload) {
  if (!payload || typeof payload !== 'object') return false
  const timestamps = [
    payload?.identity?.verifiedAt,
    payload?.startedAt,
    payload?.finishedAt,
    payload?.transcriptParity?.identity?.firstEventAt,
    payload?.transcriptParity?.identity?.lastEventAt,
    ...Object.values(payload?.timestamps || {}),
  ]
    .map((value) => Date.parse(String(value || '')))
    .filter(Number.isFinite)
  if (!timestamps.length) return false
  const ageMs = Date.now() - Math.max(...timestamps)
  return ageMs >= -5 * 60 * 1000 && (liveProofMaxAgeMs <= 0 || ageMs <= liveProofMaxAgeMs)
}

function liveProofCalleeFirst(payload) {
  const proof = liveProofSubject(payload)
  return Boolean(
    proof?.greetingRequested === false &&
      proof?.agentWaitedForCaller &&
      proof?.assistantTranscriptAfterCaller,
  )
}

function liveProofTwoSided(payload) {
  const proof = liveProofSubject(payload)
  return Boolean(proof?.conversationalTurn && proof?.enoughBackAndForth)
}

function liveProofAudioEvidence(payload) {
  const proof = liveProofSubject(payload)
  return Boolean(
    proof?.callerAudio &&
      proof?.callerAudioAudible &&
      audioEvidenceAudible(proof, 'leadCallToolsInput') &&
      proof?.assistantAudio &&
      proof?.assistantAudioAudible &&
      audioEvidenceAudible(proof, 'aiCallToolsOutput'),
  )
}

function liveProofCallControlId(payload = {}) {
  return String(
    payload?.callControlId ||
      payload?.identity?.speakCallControlId ||
      payload?.calltools?.callControlId ||
      payload?.proof?.callControlId ||
      '',
  ).trim()
}

function audioEvidenceAudible(proof, key) {
  const evidence = proof?.audio?.evidence?.[key]
  return Boolean(
    evidence?.audible === true &&
      evidence?.ok !== false &&
      evidence?.silent !== true &&
      positiveNumber(evidence?.bytes) &&
      positiveNumber(evidence?.durationSeconds),
  )
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function liveProofRecordingReviewClean(payload) {
  if (!payload || typeof payload !== 'object') return false
  if (payload.schemaVersion !== 'speak.calltools.campaign-proof.v1') return false
  const review = payload.recordingTranscriptReview
  return Boolean(
    payload.recordingTranscriptOk === true &&
      review &&
      review.ok === true &&
      String(review.status || '') === 'clean',
  )
}
