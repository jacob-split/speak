const speakLogoMarkUrl = `${import.meta.env.BASE_URL}speak-logo-mark.svg`

export function SpeakLogoMark() {
  return (
    <span className="speak-logo-mark" aria-hidden="true">
      <img src={speakLogoMarkUrl} alt="" decoding="async" />
    </span>
  )
}
