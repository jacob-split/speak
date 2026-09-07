import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applySharedCallToolsDutyBinding } from '../server/calltools-client.mjs'

const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'speak-workspace-'))
process.env.SPEAK_WORKSPACE_DATA_DIR = workspaceDir

try {
  const selectedVoiceProfile = {
    id: 'selected-voice-profile',
    name: 'Selected voice profile',
    config: { voiceRuntimeProvider: 'hume' },
  }
  const sharedBinding = {
    appUserId: 'calltools-agent-1',
    phoneId: 'calltools-phone-1',
    campaignId: 'calltools-campaign-1',
  }
  assert.throws(
    () =>
      applySharedCallToolsDutyBinding(selectedVoiceProfile, [
        {
          id: 'shared-binding-b',
          config: {
            dialerProvider: 'calltools',
            calltoolsAgentBinding: {
              ...sharedBinding,
              phoneId: 'calltools-phone-2',
            },
          },
        },
        {
          id: 'shared-binding-a',
          config: {
            dialerProvider: 'calltools',
            calltoolsAgentBinding: sharedBinding,
          },
        },
      ]),
    (error) => {
      assert.equal(error?.code, 'calltools_shared_binding_ambiguous')
      assert.deepEqual(error?.candidateProfileIds, [
        'shared-binding-a',
        'shared-binding-b',
      ])
      assert.deepEqual(error?.differingFields, ['phoneId'])
      return true
    },
    'disagreeing complete shared CallTools bindings must fail closed',
  )
  const equivalentSharedProfiles = [
    {
      id: 'shared-binding-b',
      config: {
        dialerProvider: 'calltools',
        calltoolsAgentBinding: {
          ...sharedBinding,
          mediaGatewayStatus: 'registered',
        },
      },
    },
    {
      id: 'shared-binding-a',
      config: {
        dialerProvider: 'calltools',
        calltoolsAgentBinding: {
          ...sharedBinding,
          mediaGatewayStatus: 'configured',
        },
      },
    },
  ]
  const sharedForward = applySharedCallToolsDutyBinding(
    selectedVoiceProfile,
    equivalentSharedProfiles,
  )
  const sharedReverse = applySharedCallToolsDutyBinding(
    selectedVoiceProfile,
    [...equivalentSharedProfiles].reverse(),
  )
  assert.deepEqual(
    sharedForward.config.calltoolsAgentBinding,
    sharedReverse.config.calltoolsAgentBinding,
    'equivalent shared CallTools bindings must resolve independent of input order',
  )
  assert.equal(sharedForward.config.calltoolsAgentBinding.mediaGatewayStatus, 'configured')

  const {
    createWorkspaceLead,
    importWorkspaceSourceLeads,
    patchWorkspaceLead,
    deleteWorkspaceProfile,
    replaceWorkspaceProfiles,
    resolveWorkspaceRuntimeContext,
    resolveWorkspaceRuntimeSnapshot,
    transitionWorkspaceCallToolsDuty,
    upsertWorkspaceProfile,
    workspaceSnapshot,
  } = await import('../server/workspace-store.mjs')

  await createWorkspaceLead({
    id: 'config-phone-test-ad-hoc',
    business_name: 'Stale ad hoc contact',
    name: 'Stale Playground contact',
    phone: '+15555550001',
  })
  const adHocRuntimeContext = await resolveWorkspaceRuntimeContext({
    lead: {
      id: 'config-phone-test-ad-hoc',
      business_name: 'Current ad hoc contact',
      name: 'Current Playground contact',
      phone: '+15555550002',
    },
    config: {},
  })
  assert.equal(
    adHocRuntimeContext.lead.phone,
    '+15555550002',
    'an explicit ad-hoc Playground number must not be replaced by a stale stored record',
  )
  assert.equal(
    adHocRuntimeContext.lead.name,
    'Current Playground contact',
    'an explicit ad-hoc Playground identity must not be replaced by a stale stored record',
  )
  const adHocRuntimeSnapshot = await resolveWorkspaceRuntimeSnapshot({
    lead: {
      id: 'config-phone-test-ad-hoc',
      business_name: 'Current snapshot contact',
      name: 'Current snapshot contact',
      phone: '+15555550003',
    },
    config: {},
  })
  assert.equal(
    adHocRuntimeSnapshot.lead.phone,
    '+15555550003',
    'a cached runtime snapshot must preserve the explicit ad-hoc Playground number',
  )
  const refreshedAdHocRuntimeContext = await resolveWorkspaceRuntimeContext({
    lead: {
      id: 'config-phone-test-ad-hoc',
      business_name: 'Current context contact',
      name: 'Current context contact',
      phone: '+15555550004',
      context: { urls: ['http://127.0.0.1/private'] },
    },
    config: {},
  })
  assert.equal(
    refreshedAdHocRuntimeContext.lead.phone,
    '+15555550004',
    'runtime context preparation must not reintroduce a stale ad-hoc stored record',
  )

  await createWorkspaceLead({
    id: 'personal-phone-source-lead',
    business_name: 'Acme Detail',
    name: 'Alex Morgan',
    phone: '+15555550111',
  })
  await patchWorkspaceLead('personal-phone-source-lead', {
    status: 'follow-up',
    lastCall: 'Jun 26',
    notes: 'local note survives source refresh',
    tags: ['local'],
    context: { text: 'lead-specific future-call context' },
  })

  const result = await importWorkspaceSourceLeads({
    name: 'Personal Phone Contacts',
    source: 'personal-phone',
    sourceId: 'bluebubbles:contacts',
    sourceUrl: 'bluebubbles://contacts',
    externalUrl: 'bluebubbles://contacts',
    leads: [
      {
        id: 'personal-phone-source-lead',
        business_name: 'Acme Detail',
        name: 'Imported lead 1',
        phone: '+15555550111',
        status: 'ready',
        lastCall: 'Never',
        notes: '',
        tags: [],
        providerIds: {
          bluebubblesContactId: 'contact-123',
        },
      },
      {
        id: 'personal-phone-new-source-lead',
        business_name: 'New Source Contact',
        name: 'Imported lead 2',
        phone: '+15555550112',
        status: 'ready',
        lastCall: 'Never',
        notes: '',
        tags: [],
        context: { text: '', urls: [], files: [] },
        providerIds: {
          bluebubblesContactId: 'contact-456',
        },
      },
    ],
  })

  const snapshot = await workspaceSnapshot()
  const lead = snapshot.leads.find((item) => item.id === 'personal-phone-source-lead')
  const newLead = snapshot.leads.find((item) => item.id === 'personal-phone-new-source-lead')
  assert.equal(result.contactSource.source, 'personal-phone')
  assert.equal(result.contactSource.sourceId, 'bluebubbles:contacts')
  assert.equal(result.contactSource.leadCount, 2)
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.contactSource, 'leadIds'),
    false,
    'contact source import result must expose leadCount without returning every lead id',
  )
  assert.equal(snapshot.smartViews.length, 0)
  assert.ok(
    snapshot.contactSources.every((source) => !Object.prototype.hasOwnProperty.call(source, 'leadIds')),
    'workspace contact source summaries must not carry large leadIds arrays',
  )
  assert.equal(lead.source, 'personal-phone')
  assert.equal(lead.sourceId, 'bluebubbles:contacts')
  assert.equal(lead.sourceName, 'Personal Phone Contacts')
  assert.equal(lead.sourceUrl, 'bluebubbles://contacts')
  assert.equal(lead.externalUrl, 'bluebubbles://contacts')
  assert.ok(lead.sourceSyncedAt)
  assert.equal(Object.prototype.hasOwnProperty.call(lead, 'providerIds'), false)
  assert.equal(lead.status, 'follow-up')
  assert.equal(lead.lastCall, 'Jun 26')
  assert.equal(lead.notes, 'local note survives source refresh')
  assert.deepEqual(lead.tags, ['local'])
  assert.equal(lead.context.text, 'lead-specific future-call context')
  assert.equal(lead.name, 'Alex Morgan')
  assert.equal(lead.company, 'Acme Detail')
  assert.equal(newLead.notes, '')
  assert.equal(newLead.context.text, '')
  assert.equal(Object.prototype.hasOwnProperty.call(newLead, 'providerIds'), false)

  await importWorkspaceSourceLeads({
    name: 'CallTools Campaign',
    source: 'calltools',
    sourceId: 'calltools:campaign:42',
    leads: [
      {
        id: 'calltools-source-lead',
        business_name: 'CallTools Account',
        name: 'Casey Operator',
        phone: '+15555550113',
        providerIds: {
          calltoolsContactId: '987',
          calltoolsCampaignId: '42',
        },
      },
    ],
  })
  await importWorkspaceSourceLeads({
    name: 'CallTools Follow-Up Campaign',
    source: 'calltools',
    sourceId: 'calltools:campaign:43',
    leads: [
      {
        id: 'calltools-source-lead-2',
        business_name: 'Second CallTools Account',
        name: 'Dana Operator',
        phone: '+15555550114',
        providerIds: {
          calltoolsContactId: '988',
          calltoolsCampaignId: '43',
        },
      },
    ],
  })
  const afterCallTools = await workspaceSnapshot()
  const callToolsLead = afterCallTools.leads.find((item) => item.id === 'calltools-source-lead')
  assert.equal(callToolsLead.providerIds.calltoolsContactId, '987')
  assert.equal(callToolsLead.providerIds.calltoolsCampaignId, '42')
  const callToolsSources = afterCallTools.contactSources.filter(
    (source) => source.source === 'calltools',
  )
  assert.equal(callToolsSources.length, 2)
  assert.ok(
    callToolsSources.every((source) => !Object.prototype.hasOwnProperty.call(source, 'leadIds')),
    'CallTools contact source summaries must stay count-only for large campaigns',
  )
  assert.deepEqual(
    callToolsSources.map((source) => source.sourceId).sort(),
    ['calltools:campaign:42', 'calltools:campaign:43'],
  )

  await replaceWorkspaceProfiles({
    profiles: [
      {
        id: 'profile-personal-phone',
        name: 'Personal phone agent',
        config: {
          contactSource: 'personal-phone',
          contactSourceId: 'bluebubbles:contacts',
          dialerProvider: 'speak',
          telnyxCallerId: '+15555551882',
        },
      },
      {
        id: 'profile-unassigned',
        name: 'Unassigned Speak agent',
        config: {
          dialerProvider: 'speak',
        },
      },
      {
        id: 'profile-calltools',
        name: 'CallTools agent',
        config: {
          contactSource: 'calltools',
          contactSourceId: 'calltools:campaign:42',
          dialerProvider: 'calltools',
          telnyxCallerId: '+15555551999',
          telnyxConnectionId: 'telnyx-connection-shared',
          calltoolsAgentBinding: {
            enabled: true,
            mode: 'phone_as_agent',
            appUserId: 'calltools-agent-1',
            phoneId: 'calltools-phone-1',
            campaignId: 'calltools-campaign-1',
            bucketId: 'calltools-bucket-1',
          },
        },
      },
    ],
    activeProfileId: 'profile-personal-phone',
  })
  const profileSnapshot = await workspaceSnapshot()
  const unassignedProfile = profileSnapshot.profiles.find(
    (profile) => profile.id === 'profile-unassigned',
  )
  const calltoolsProfile = profileSnapshot.profiles.find(
    (profile) => profile.id === 'profile-calltools',
  )
  const personalPhoneProfile = profileSnapshot.profiles.find(
    (profile) => profile.id === 'profile-personal-phone',
  )
  assert.equal(personalPhoneProfile.config.contactSource, 'personal-phone')
  assert.equal(personalPhoneProfile.config.contactSourceId, 'bluebubbles:contacts')
  assert.equal(unassignedProfile.config.telnyxCallerId, '')
  assert.equal(unassignedProfile.config.telnyxConnectionId, '')
  assert.equal(calltoolsProfile.config.contactSource, 'calltools')
  assert.equal(calltoolsProfile.config.contactSourceId, 'calltools:campaign:42')
  assert.equal(calltoolsProfile.config.telnyxCallerId, '+15555551999')
  assert.equal(
    calltoolsProfile.config.telnyxConnectionId,
    '',
    'the outbound Call Control connection stays workspace-owned rather than profile-owned',
  )
  await transitionWorkspaceCallToolsDuty({
    expectedLeaseId: '',
    patch: {
      leaseId: 'lease-profile-calltools',
      status: 'on',
      profileId: 'profile-calltools',
      binding: {
        appUserId: 'calltools-agent-1',
        phoneId: 'calltools-phone-1',
        campaignId: 'calltools-campaign-1',
      },
    },
  })
  const safeLeasedProfileEdit = await upsertWorkspaceProfile({
    ...calltoolsProfile,
    name: 'CallTools agent updated safely',
    config: {
      ...calltoolsProfile.config,
      instructions: 'Updated instructions that do not change the active dialer assignment.',
    },
  })
  assert.equal(safeLeasedProfileEdit.name, 'CallTools agent updated safely')
  await assert.rejects(
    () =>
      upsertWorkspaceProfile({
        ...safeLeasedProfileEdit,
        config: {
          ...safeLeasedProfileEdit.config,
          calltoolsAgentBinding: {
            ...safeLeasedProfileEdit.config.calltoolsAgentBinding,
            phoneId: 'calltools-phone-reassigned',
          },
        },
      }),
    (error) => error?.code === 'calltools_active_profile_locked',
    'an active leased profile cannot change its CallTools binding',
  )
  const transportNeutralLeasedEdit = await upsertWorkspaceProfile({
    ...safeLeasedProfileEdit,
    config: {
      ...safeLeasedProfileEdit.config,
      dialerProvider: 'speak',
    },
  })
  assert.equal(
    transportNeutralLeasedEdit.config.dialerProvider,
    'speak',
    'a saved dialer default is not part of the frozen CallTools lease binding',
  )
  const safeOtherProfileEdit = await upsertWorkspaceProfile({
    ...unassignedProfile,
    name: 'Unassigned Speak agent updated safely',
  })
  assert.equal(safeOtherProfileEdit.name, 'Unassigned Speak agent updated safely')
  const snapshotBeforeSafeReplacement = await workspaceSnapshot()
  const safeReplacement = await replaceWorkspaceProfiles({
    profiles: snapshotBeforeSafeReplacement.profiles.map((profile) =>
      profile.id === 'profile-calltools'
        ? { ...profile, name: 'CallTools agent safely replaced' }
        : profile,
    ),
    activeProfileId: snapshotBeforeSafeReplacement.activeProfileId,
  })
  assert.equal(
    safeReplacement.profiles.find((profile) => profile.id === 'profile-calltools')?.name,
    'CallTools agent safely replaced',
  )
  const profilesBeforeProtectedReplacement = safeReplacement.profiles
  await assert.rejects(
    () =>
      replaceWorkspaceProfiles({
        profiles: profilesBeforeProtectedReplacement.map((profile) =>
          profile.id === 'profile-calltools'
            ? {
                ...profile,
                config: {
                  ...profile.config,
                  calltoolsAgentBinding: {
                    ...profile.config.calltoolsAgentBinding,
                    campaignId: 'calltools-campaign-reassigned',
                  },
                },
              }
            : profile,
        ),
        activeProfileId: snapshotBeforeSafeReplacement.activeProfileId,
      }),
    (error) => error?.code === 'calltools_active_profile_locked',
    'bulk profile replacement cannot change the active leased binding',
  )
  await assert.rejects(
    () =>
      replaceWorkspaceProfiles({
        profiles: profilesBeforeProtectedReplacement.filter(
          (profile) => profile.id !== 'profile-calltools',
        ),
        activeProfileId: 'profile-personal-phone',
      }),
    (error) => error?.code === 'calltools_active_profile_locked',
    'bulk profile replacement cannot remove the active leased profile',
  )
  await assert.rejects(
    () => deleteWorkspaceProfile('profile-calltools'),
    (error) => error?.code === 'calltools_active_profile_locked',
    'the active leased profile cannot be deleted',
  )
  await assert.rejects(
    () =>
      upsertWorkspaceProfile({
        id: 'profile-conflicting-personal-source',
        name: 'Conflicting personal source agent',
        config: {
          contactSource: 'personal-phone',
          contactSourceId: 'bluebubbles:contacts',
          dialerProvider: 'speak',
        },
      }),
    /Personal Phone source bluebubbles:contacts is already assigned/,
  )
  await assert.rejects(
    () =>
      upsertWorkspaceProfile({
        id: 'profile-conflicting-calltools-source',
        name: 'Conflicting CallTools source agent',
        config: {
          contactSource: 'calltools',
          contactSourceId: 'calltools:campaign:42',
          dialerProvider: 'calltools',
          calltoolsAgentBinding: {
            enabled: true,
            mode: 'phone_as_agent',
            phoneId: 'calltools-phone-2',
          },
        },
      }),
    /CallTools source calltools:campaign:42 is already assigned/,
  )
  const sharedOwnedPhone = await upsertWorkspaceProfile({
    id: 'profile-shared-owned-speak-phone',
    name: 'Shared owned Speak phone agent',
    config: {
      dialerProvider: 'speak',
      phoneCallerId: '+15555551882',
    },
  })
  assert.equal(
    sharedOwnedPhone.id,
    'profile-shared-owned-speak-phone',
    'owned Speak/Telnyx caller IDs may be selected by more than one agent profile',
  )
  const recoveredSharedPhone = await upsertWorkspaceProfile({
    ...sharedOwnedPhone,
    config: {
      ...sharedOwnedPhone.config,
      humeConfigId: 'qa-recovered-hume-config',
      humeConfigVersion: 2,
    },
  })
  assert.equal(
    recoveredSharedPhone.config?.humeConfigVersion,
    2,
    'provider-proof recovery upserts remain valid when owned Speak caller IDs are shared',
  )
  await assert.rejects(
    () =>
      upsertWorkspaceProfile({
        id: 'profile-conflicting-calltools',
        name: 'Conflicting CallTools agent',
        config: {
          dialerProvider: 'calltools',
          calltoolsAgentBinding: {
            enabled: true,
            mode: 'phone_as_agent',
            phoneId: 'calltools-phone-1',
            campaignId: 'calltools-campaign-2',
          },
        },
    }),
    /CallTools phone calltools-phone-1 is already assigned/,
  )
  await transitionWorkspaceCallToolsDuty({
    expectedLeaseId: 'lease-profile-calltools',
    patch: {
      status: 'disarming',
    },
  })
  await assert.rejects(
    () => deleteWorkspaceProfile('profile-calltools'),
    (error) => error?.code === 'calltools_active_profile_locked',
    'the profile assignment remains locked until the unavailable handoff completes',
  )
  await transitionWorkspaceCallToolsDuty({
    expectedLeaseId: 'lease-profile-calltools',
    patch: {
      leaseId: '',
      status: 'off',
      profileId: '',
      binding: {},
    },
  })
  const afterExplicitUnavailable = await deleteWorkspaceProfile('profile-calltools')
  assert.equal(
    afterExplicitUnavailable.profiles.some((profile) => profile.id === 'profile-calltools'),
    false,
    'the profile mutation lock releases only after explicit Unavailable proof',
  )

  const appSource = readFileSync('src/App.tsx', 'utf8')
  const agentWorkspaceSource = readFileSync('src/AgentConfigWorkspace.tsx', 'utf8')
  const globalSearchSource = readFileSync('src/GlobalSearchOverlay.tsx', 'utf8')
  const contactSourcesSource = readFileSync('src/contactSources.ts', 'utf8')
  const runControlsSource = readFileSync('src/DialerRunControls.tsx', 'utf8')
  const serverIndex = readFileSync('server/index.mjs', 'utf8')
  const settingsPanel = readFileSync('src/SpeakSettingsPanel.tsx', 'utf8')
  const typesSource = readFileSync('src/types.ts', 'utf8')
  const uiContractSource = readFileSync('src/uiContract.ts', 'utf8')
  const workspaceStoreSource = readFileSync('server/workspace-store.mjs', 'utf8')
  assert.match(uiContractSource, /selectContactSource: 'select_contact_source'/)
  assert.match(runControlsSource, /activeSmartViewId: string/)
  assert.match(runControlsSource, /data-action-id=\{speakActionIds\.selectContactSource\}/)
  assert.match(runControlsSource, /data-action-id=\{speakActionIds\.selectSmartView\}/)
  assert.match(runControlsSource, /value=\{activeSmartViewId\}/)
  assert.doesNotMatch(runControlsSource, /value=\{`smart:\$\{smartView\.id\}`\}/)
  assert.match(settingsPanel, /config\.telnyxCallerId \|\| config\.phoneCallerId \|\| ''/)
  assert.match(settingsPanel, /Contact source/)
  assert.match(settingsPanel, /selectContactSource\(event\.target\.value\)/)
  assert.doesNotMatch(settingsPanel, /config\.telnyxCallerId \|\| backendDefaults\.telnyxCallerId/)
  assert.match(appSource, /rawSourceId\.startsWith\('smart:'\) \? '' : rawSourceId/)
  assert.match(appSource, /buildContactSourceOptionsFromLeads\(leads\)/)
  assert.match(contactSourcesSource, /encodeURIComponent\(normalizedSourceId\)/)
  assert.match(contactSourcesSource, /leadMatchesContactSourceKey/)
  assert.match(contactSourcesSource, /selection\.sourceId \? lead\.sourceId === selection\.sourceId : true/)
  assert.match(appSource, /function selectDialerSmartView\(smartViewId: string\)/)
  assert.match(appSource, /onSelectSmartView=\{selectDialerSmartView\}/)
  assert.match(serverIndex, /app\.get\('\/api\/search'/)
  assert.match(workspaceStoreSource, /export async function searchWorkspace/)
  assert.match(workspaceStoreSource, /boundedLimit\(filters\.limit,\s*24,\s*100\)/)
  assert.match(workspaceStoreSource, /export async function listWorkspaceLeads\(filters = \{\}\)/)
  assert.match(workspaceStoreSource, /boundedLimit\(filters\.limit,\s*100,\s*500\)/)
  assert.match(serverIndex, /listWorkspaceLeads\(request\.query \|\| \{\}\)/)
  assert.match(globalSearchSource, /apiUrl\(`\/search\?\$\{searchParams\.toString\(\)\}`\)/)
  assert.doesNotMatch(
    globalSearchSource,
    /apiUrl\('\/workspace'\)/,
    'Global search must not fetch the full workspace for large contact sets',
  )
  assert.match(agentWorkspaceSource, /apiUrl\(`\/leads\?\$\{params\.toString\(\)\}`\)/)
  assert.match(agentWorkspaceSource, /apiUrl\('\/smart-views'\)/)
  assert.match(agentWorkspaceSource, /contactSources=\{contactSources\}/)
  assert.match(workspaceStoreSource, /contactSources: summarizeWorkspaceContactSources\(workspace\)/)
  assert.match(workspaceStoreSource, /function publicWorkspaceContactSource/)
  assert.doesNotMatch(
    typesSource,
    /interface ContactSource\s*\{[^}]*leadIds\??:/,
    'ContactSource summaries must expose leadCount instead of large leadIds arrays',
  )
  assert.match(workspaceStoreSource, /source:contact-source:\$\{contactSource\}:\$\{contactSourceId \|\| '\*'\}/)
  assert.doesNotMatch(
    agentWorkspaceSource,
    /apiUrl\('\/workspace'\)/,
    'Playground contact picker must use bounded lead reads instead of full workspace hydration',
  )

  console.log('Source import merge checks passed.')
} finally {
  await rm(workspaceDir, { force: true, recursive: true })
}
