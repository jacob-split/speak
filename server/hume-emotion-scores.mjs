export function extractHumeEmotionScores(message = {}) {
  const candidates = [
    message.models?.prosody?.scores,
    message.message?.models?.prosody?.scores,
    message.prosody?.scores,
    message.message?.prosody?.scores,
    message.emotionScores,
    message.emotion_scores,
    message.emotionFeatures,
    message.emotion_features,
  ]

  for (const candidate of candidates) {
    const scores = normalizeEmotionScores(candidate)
    if (scores) return scores
  }

  return null
}

export function normalizeEmotionScores(value) {
  const parsed = parseEmotionScores(value)
  if (!parsed) return null

  const entries = Array.isArray(parsed)
    ? parsed.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const name = item.name || item.emotion || item.label
        const score = item.score ?? item.value
        return name ? [[name, score]] : []
      })
    : Object.entries(parsed)

  const scores = Object.fromEntries(
    entries.flatMap(([name, score]) => {
      const numericScore = Number(score)
      if (!String(name || '').trim() || !Number.isFinite(numericScore)) return []
      return [[String(name).trim(), numericScore]]
    }),
  )

  return Object.keys(scores).length > 0 ? scores : null
}

function parseEmotionScores(value) {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  if (typeof value === 'object') return value
  return null
}
