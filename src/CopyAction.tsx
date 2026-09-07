import { Check, Copy } from './SpeakIcons'
import { useClipboardCopy } from './useClipboardCopy'

interface CopyActionProps {
  className?: string
  disabled?: boolean
  label?: string
  size?: number
  value: string
}

export function CopyAction({
  className = '',
  disabled = false,
  label = 'Copy',
  size = 14,
  value,
}: CopyActionProps) {
  const { copied, copyText } = useClipboardCopy()
  const unavailable = disabled || !value.trim()

  async function copyValue() {
    if (unavailable) return
    await copyText(value)
  }

  return (
    <button
      className={[
        'copy-action',
        copied ? 'copied' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      type="button"
      title={copied ? 'Copied' : label}
      aria-label={copied ? 'Copied' : label}
      disabled={unavailable}
      onClick={copyValue}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
      {copied && <span>Copied</span>}
    </button>
  )
}
