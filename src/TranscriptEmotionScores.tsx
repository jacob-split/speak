import { topEmotionScores } from './emotionScores'

interface TranscriptEmotionScoresProps {
  scores?: Record<string, number>
}

export function TranscriptEmotionScores({
  scores,
}: TranscriptEmotionScoresProps) {
  const topScores = topEmotionScores(scores)
  if (topScores.length === 0) return null

  return (
    <div className="emotion-score-strip" aria-label="Top emotion scores">
      {topScores.map((score) => (
        <div className="emotion-score-item" key={score.label}>
          <div className="emotion-score-heading">
            <span>{score.label}</span>
            <span>{score.value.toFixed(2)}</span>
          </div>
          <div className="emotion-score-track" aria-hidden="true">
            <span
              className="emotion-score-fill"
              style={{
                background: score.color,
                width: `${Math.round(score.value * 100)}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
