import type { ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import {
  Activity as LucideActivity,
  AlertCircle as LucideAlertCircle,
  ArrowDown as LucideArrowDown,
  ArrowUp as LucideArrowUp,
  Bot as LucideBot,
  BotMessageSquare as LucideBotMessageSquare,
  BriefcaseBusiness as LucideBriefcaseBusiness,
  Building2 as LucideBuilding2,
  CalendarClock as LucideCalendarClock,
  Check as LucideCheck,
  CheckCircle2 as LucideCheckCircle2,
  ChevronDown as LucideChevronDown,
  ChevronUp as LucideChevronUp,
  Clock3 as LucideClock3,
  Copy as LucideCopy,
  Ear as LucideEar,
  FileText as LucideFileText,
  History as LucideHistory,
  LibraryBig as LucideLibraryBig,
  Link2 as LucideLink2,
  Mail as LucideMail,
  MapPin as LucideMapPin,
  Maximize2 as LucideMaximize2,
  MessageSquare as LucideMessageSquare,
  MessageSquareText as LucideMessageSquareText,
  MessagesSquare as LucideMessagesSquare,
  Mic as LucideMic,
  Minimize2 as LucideMinimize2,
  Monitor as LucideMonitor,
  Moon as LucideMoon,
  MoreHorizontal as LucideMoreHorizontal,
  Pause as LucidePause,
  Phone as LucidePhone,
  PhoneCall as LucidePhoneCall,
  Play as LucidePlay,
  Plus as LucidePlus,
  RefreshCw as LucideRefreshCw,
  Reply as LucideReply,
  Save as LucideSave,
  Search as LucideSearch,
  Settings2 as LucideSettings2,
  SkipForward as LucideSkipForward,
  SlidersHorizontal as LucideSlidersHorizontal,
  Square as LucideSquare,
  SquarePen as LucideSquarePen,
  Sun as LucideSun,
  Tags as LucideTags,
  Trash2 as LucideTrash2,
  Upload as LucideUpload,
  X as LucideX,
} from 'lucide-react'

export interface SpeakIconProps extends LucideProps {
  size?: number | string
}

const SPEAK_ICON_STROKE = 1.65

function createSpeakIcon(displayName: string, Icon: ComponentType<LucideProps>) {
  function SpeakIcon({ className, ...props }: SpeakIconProps) {
    return (
      <Icon
        {...props}
        className={className ? `speak-icon ${className}` : 'speak-icon'}
        fill="none"
        strokeWidth={SPEAK_ICON_STROKE}
        absoluteStrokeWidth={false}
      />
    )
  }

  SpeakIcon.displayName = displayName
  return SpeakIcon
}

export const Activity = createSpeakIcon('Activity', LucideActivity)
export const AlertCircle = createSpeakIcon('AlertCircle', LucideAlertCircle)
export const ArrowDown = createSpeakIcon('ArrowDown', LucideArrowDown)
export const ArrowUp = createSpeakIcon('ArrowUp', LucideArrowUp)
export const Bot = createSpeakIcon('Bot', LucideBot)
export const BotMessageSquare = createSpeakIcon('BotMessageSquare', LucideBotMessageSquare)
export const BriefcaseBusiness = createSpeakIcon('BriefcaseBusiness', LucideBriefcaseBusiness)
export const Building2 = createSpeakIcon('Building2', LucideBuilding2)
export const CalendarClock = createSpeakIcon('CalendarClock', LucideCalendarClock)
export const Check = createSpeakIcon('Check', LucideCheck)
export const CheckCircle2 = createSpeakIcon('CheckCircle2', LucideCheckCircle2)
export const ChevronDown = createSpeakIcon('ChevronDown', LucideChevronDown)
export const ChevronUp = createSpeakIcon('ChevronUp', LucideChevronUp)
export const Clock3 = createSpeakIcon('Clock3', LucideClock3)
export const Copy = createSpeakIcon('Copy', LucideCopy)
export const Ear = createSpeakIcon('Ear', LucideEar)
export const FileText = createSpeakIcon('FileText', LucideFileText)
export const History = createSpeakIcon('History', LucideHistory)
export const LibraryBig = createSpeakIcon('LibraryBig', LucideLibraryBig)
export const Link2 = createSpeakIcon('Link2', LucideLink2)
export const Mail = createSpeakIcon('Mail', LucideMail)
export const MapPin = createSpeakIcon('MapPin', LucideMapPin)
export const Maximize2 = createSpeakIcon('Maximize2', LucideMaximize2)
export const MessageSquare = createSpeakIcon('MessageSquare', LucideMessageSquare)
export const MessageSquareText = createSpeakIcon('MessageSquareText', LucideMessageSquareText)
export const MessagesSquare = createSpeakIcon('MessagesSquare', LucideMessagesSquare)
export const Mic = createSpeakIcon('Mic', LucideMic)
export const Minimize2 = createSpeakIcon('Minimize2', LucideMinimize2)
export const Monitor = createSpeakIcon('Monitor', LucideMonitor)
export const Moon = createSpeakIcon('Moon', LucideMoon)
export const MoreHorizontal = createSpeakIcon('MoreHorizontal', LucideMoreHorizontal)
export const Pause = createSpeakIcon('Pause', LucidePause)
export const Phone = createSpeakIcon('Phone', LucidePhone)
export const PhoneCall = createSpeakIcon('PhoneCall', LucidePhoneCall)
export const Play = createSpeakIcon('Play', LucidePlay)
export const Plus = createSpeakIcon('Plus', LucidePlus)
export const RefreshCw = createSpeakIcon('RefreshCw', LucideRefreshCw)
export const Reply = createSpeakIcon('Reply', LucideReply)
export const Save = createSpeakIcon('Save', LucideSave)
export const Search = createSpeakIcon('Search', LucideSearch)
export const Settings2 = createSpeakIcon('Settings2', LucideSettings2)
export const SkipForward = createSpeakIcon('SkipForward', LucideSkipForward)
export const SlidersHorizontal = createSpeakIcon('SlidersHorizontal', LucideSlidersHorizontal)
export const Square = createSpeakIcon('Square', LucideSquare)
export const SquarePen = createSpeakIcon('SquarePen', LucideSquarePen)
export const Sun = createSpeakIcon('Sun', LucideSun)
export const Tags = createSpeakIcon('Tags', LucideTags)
export const Trash2 = createSpeakIcon('Trash2', LucideTrash2)
export const Upload = createSpeakIcon('Upload', LucideUpload)
export const X = createSpeakIcon('X', LucideX)
