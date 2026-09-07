export interface EmotionScoreDisplay {
  label: string
  value: number
  color: string
}

const emotionColorByGroup = {
  attentive: '#a8cfe0',
  positive: '#83c5be',
  warm: '#e9b886',
  uneasy: '#d2d694',
  adverse: '#d9786f',
  low: '#9ba9c8',
  surprise: '#111315',
}

export const humeEmotionScorecard = [
  ['Admiration', 'positive'],
  ['Adoration', 'warm'],
  ['Aesthetic Appreciation', 'positive'],
  ['Amusement', 'positive'],
  ['Anger', 'adverse'],
  ['Anxiety', 'adverse'],
  ['Awe', 'positive'],
  ['Awkwardness', 'uneasy'],
  ['Boredom', 'low'],
  ['Calmness', 'attentive'],
  ['Concentration', 'attentive'],
  ['Confusion', 'uneasy'],
  ['Contemplation', 'attentive'],
  ['Contempt', 'adverse'],
  ['Contentment', 'positive'],
  ['Craving', 'warm'],
  ['Desire', 'warm'],
  ['Determination', 'attentive'],
  ['Disappointment', 'low'],
  ['Disgust', 'adverse'],
  ['Distress', 'adverse'],
  ['Doubt', 'uneasy'],
  ['Ecstasy', 'positive'],
  ['Embarrassment', 'uneasy'],
  ['Empathic Pain', 'low'],
  ['Entrancement', 'positive'],
  ['Envy', 'uneasy'],
  ['Excitement', 'positive'],
  ['Fear', 'adverse'],
  ['Guilt', 'low'],
  ['Horror', 'adverse'],
  ['Interest', 'attentive'],
  ['Joy', 'positive'],
  ['Love', 'warm'],
  ['Nostalgia', 'low'],
  ['Pain', 'adverse'],
  ['Pride', 'positive'],
  ['Realization', 'attentive'],
  ['Relief', 'positive'],
  ['Romance', 'warm'],
  ['Sadness', 'low'],
  ['Satisfaction', 'positive'],
  ['Shame', 'low'],
  ['Surprise (negative)', 'surprise'],
  ['Surprise (positive)', 'surprise'],
  ['Sympathy', 'warm'],
  ['Tiredness', 'low'],
  ['Triumph', 'positive'],
] as const

const labelByKey = new Map(
  humeEmotionScorecard.flatMap(([label]) => [
    [emotionKey(label), label],
    [emotionKey(camelCaseEmotionLabel(label)), label],
  ]),
)

const colorByLabel = new Map<string, string>(
  humeEmotionScorecard.map(([label, group]) => [
    label,
    emotionColorByGroup[group],
  ]),
)

export function topEmotionScores(
  scores?: Record<string, number>,
  limit = 3,
): EmotionScoreDisplay[] {
  if (!scores) return []

  return Object.entries(scores)
    .flatMap(([name, value]) => {
      const numericValue = Number(value)
      if (!Number.isFinite(numericValue) || numericValue <= 0) return []
      const label = normalizedEmotionLabel(name)
      return [
        {
          label,
          value: clampEmotionScore(numericValue),
          color: colorByLabel.get(label) || emotionColorByGroup.attentive,
        },
      ]
    })
    .sort((left, right) => right.value - left.value)
    .slice(0, limit)
}

export function normalizedEmotionLabel(name: string) {
  const trimmed = String(name || '').trim()
  return labelByKey.get(emotionKey(trimmed)) || trimmed
}

function emotionKey(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function camelCaseEmotionLabel(label: string) {
  return label
    .replace(/[()]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part, index) =>
      index === 0
        ? part.charAt(0).toLowerCase() + part.slice(1)
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join('')
}

function clampEmotionScore(value: number) {
  return Math.max(0, Math.min(1, value))
}
