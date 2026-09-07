import { PassThrough } from 'node:stream'
import {
  buildContextToolPayload,
  deleteContextFile,
  prepareRuntimeContextFields,
  renderRuntimeContext,
  saveContextFileFromRequest,
} from '../server/context-fields.mjs'

const uploaded = []

try {
  const markdown = await uploadContextFile({
    name: 'customer-notes.md',
    type: 'text/markdown',
    body: '# Customer notes\nPreferred plan: monthly billing. Mention the bronze package only if asked.',
  })
  uploaded.push(markdown.id)

  const csv = await uploadContextFile({
    name: 'customer-data.csv',
    type: 'text/csv',
    body: 'field,value\ncustomer_status,priority\nrenewal_window,August',
  })
  uploaded.push(csv.id)

  assert(
    markdown.extractedText.includes('bronze package'),
    'markdown upload did not extract file text',
  )
  assert(csv.extractedText.includes('renewal_window'), 'csv upload did not extract file text')

  const runtimeContext = renderRuntimeContext({
    leadContext: {
      text: 'Call after 2 PM. If the contact asks about package details, retrieve the attached customer notes first.',
      files: [markdown, csv],
    },
    profileContext: {
      text: 'Agent-level context should apply globally.',
    },
    conversationMemory: [
      {
        date: '2026-06-25T10:00:00.000Z',
        agent: 'QA Agent',
        outcome: 'follow-up',
        insight: 'Contact asked about monthly billing.',
        turns: [{ speaker: 'Lead', text: 'Can you explain billing again?' }],
      },
    ],
  })

  assert(runtimeContext.includes('retrieve the attached customer notes'), 'runtime context omitted context instructions')
  assert(runtimeContext.includes('customer-notes.md'), 'runtime context omitted file inventory')
  assert(!runtimeContext.includes('bronze package'), 'runtime context injected arbitrary file content')
  assert(runtimeContext.includes('conversation_memory'), 'runtime context omitted prior-call memory inventory')
  assert(!runtimeContext.includes('Can you explain billing again'), 'runtime context injected prior-call transcript content')

  const toolPayload = buildContextToolPayload({
    leadContext: {
      files: [markdown, csv],
    },
    legacyNotes: 'Contact asked for a concise version.',
  })
  assert(
    JSON.stringify(toolPayload).includes('renewal_window'),
    'context tool payload omitted extracted file content',
  )

  const blockedPrivateUrl = await prepareRuntimeContextFields({
    leadContext: {
      urls: ['http://127.0.0.1/context'],
    },
  })
  const blockedSnapshot = blockedPrivateUrl.leadContext.urlSnapshots[0]
  assert(blockedSnapshot?.status === 'error', 'private URL was not blocked')
  assert(
    blockedSnapshot.error.includes('private or reserved'),
    'private URL block did not explain the network restriction',
  )

  const publicUrl = await prepareRuntimeContextFields({
    leadContext: {
      urls: ['https://example.com/'],
    },
  })
  const publicSnapshot = publicUrl.leadContext.urlSnapshots[0]
  assert(publicSnapshot?.text.includes('Example Domain'), 'public URL content was not fetched')

  console.log('context runtime checks passed')
} finally {
  await Promise.all(uploaded.map((id) => deleteContextFile(id)))
}

function uploadContextFile({ name, type, body }) {
  const request = new PassThrough()
  request.headers = {
    'content-type': type,
    'x-speak-file-name': encodeURIComponent(name),
  }
  request.end(Buffer.from(body))
  return saveContextFileFromRequest(request)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
