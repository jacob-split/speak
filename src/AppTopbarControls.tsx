import {
  AlertCircle,
  BotMessageSquare,
  ChevronDown,
  Check,
  LibraryBig,
  Monitor,
  Moon,
  MoreHorizontal,
  PhoneCall,
  Plus,
  Search,
  SlidersHorizontal,
  Sun,
} from './SpeakIcons'
import {
  type MouseEvent,
  type Ref,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from 'react'
import type { AgentConfigProfile } from './agentConfigs'
import { navigateToAppUrl } from './navigation'
import { formatOperationalDateTime } from './time'
import { speakActionIds, speakTestIds } from './uiContract'
import type { Appearance } from './useAppearance'
import { useDismissibleLayer } from './useDismissibleLayer'

export type TopbarStatusTone = 'down' | 'ready' | 'warning'
export type AppRouteId = 'dialer' | 'configs' | 'library'

const codexIconLight = `${import.meta.env.BASE_URL}codex-icon-light.png`
const codexIconDark = `${import.meta.env.BASE_URL}codex-icon-dark.png`

const appearanceOptions = [
  {
    value: 'system' as const,
    label: 'System',
    title: 'Use system appearance',
    Icon: Monitor,
  },
  {
    value: 'light' as const,
    label: 'Light',
    title: 'Use light appearance',
    Icon: Sun,
  },
  {
    value: 'dark' as const,
    label: 'Dark',
    title: 'Use dark appearance',
    Icon: Moon,
  },
]

interface AppearanceSwitchProps {
  appearance: Appearance
  setAppearance: (appearance: Appearance) => void
}

export function AppearanceSwitch({
  appearance,
  setAppearance,
}: AppearanceSwitchProps) {
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const appearanceMenuRef = useRef<HTMLDivElement>(null)
  const selectedOption =
    appearanceOptions.find((option) => option.value === appearance) ||
    appearanceOptions[0]
  const SelectedIcon = selectedOption.Icon

  const dismissAppearance = useCallback(() => {
    setAppearanceOpen(false)
  }, [])

  useDismissibleLayer({
    enabled: appearanceOpen,
    onDismiss: dismissAppearance,
    refs: [appearanceMenuRef],
  })

  return (
    <div
      className="appearance-switch"
      ref={appearanceMenuRef}
    >
      <button
        className="appearance-trigger"
        type="button"
        data-action-id={speakActionIds.selectAppearance}
        data-testid={speakTestIds.appearanceTrigger}
        title={`Appearance: ${selectedOption.label}`}
        aria-label={`Appearance: ${selectedOption.label}`}
        aria-expanded={appearanceOpen}
        onClick={() => setAppearanceOpen((current) => !current)}
      >
        <SelectedIcon size={16} />
      </button>
      {appearanceOpen && (
        <div className="appearance-popover" role="menu" aria-label="Appearance">
          {appearanceOptions.map(({ value, label, title, Icon }) => (
            <button
              key={value}
              className={appearance === value ? 'selected' : ''}
              type="button"
              data-action-id={`${speakActionIds.selectAppearance}_${value}`}
              role="menuitemradio"
              title={title}
              aria-checked={appearance === value}
              onClick={() => {
                setAppearance(value)
                setAppearanceOpen(false)
              }}
            >
              <Icon size={15} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function CodexAppIcon() {
  return (
    <span className="codex-app-icon" aria-hidden="true">
      <img className="codex-app-icon-light" src={codexIconLight} alt="" />
      <img className="codex-app-icon-dark" src={codexIconDark} alt="" />
    </span>
  )
}

interface GlobalSearchTriggerProps {
  onClick: () => void
}

export function GlobalSearchTrigger({ onClick }: GlobalSearchTriggerProps) {
  return (
    <button
      className="icon-button global-search-trigger"
      type="button"
      data-action-id={speakActionIds.openGlobalSearch}
      data-testid={speakTestIds.globalSearchTrigger}
      title="Search Speak"
      aria-label="Search Speak"
      onClick={onClick}
    >
      <Search size={17} />
    </button>
  )
}

interface AppPrimaryNavigationProps {
  active: AppRouteId
  basePath: string
}

export function AppPrimaryNavigation({
  active,
  basePath,
}: AppPrimaryNavigationProps) {
  const root = basePath || ''
  function handleRouteClick(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey
    ) {
      return
    }

    event.preventDefault()
    navigateToAppUrl(href)
  }

  const routes = [
    {
      id: 'library' as const,
      href: `${root}/library`,
      title: 'Open contact library',
      label: 'Library',
      icon: <LibraryBig size={17} />,
      actionId: speakActionIds.routeToLibrary,
    },
    {
      id: 'dialer' as const,
      href: `${root}/dialer`,
      title: 'Open dialer',
      label: 'Dialer',
      icon: <PhoneCall size={17} />,
      actionId: speakActionIds.routeToDialer,
    },
    {
      id: 'configs' as const,
      href: `${root}/configs`,
      title: 'Open playground',
      label: 'Playground',
      icon: <BotMessageSquare size={17} />,
      actionId: speakActionIds.routeToConfigs,
    },
  ]

  return (
    <nav
      className="app-primary-nav"
      data-active-route={active}
      data-testid={speakTestIds.routeSwitch}
      aria-label="Primary app navigation"
    >
      {routes.map((route) => {
        const isActive = active === route.id
        return (
          <a
            key={route.id}
            className={['icon-button', 'app-nav-item', isActive ? 'active' : '']
              .filter(Boolean)
              .join(' ')}
            data-action-id={route.actionId}
            data-route-nav-id={route.id}
            href={route.href}
            onClick={(event) => handleRouteClick(event, route.href)}
            title={route.title}
            aria-label={route.label}
            aria-current={isActive ? 'page' : undefined}
          >
            <span className="app-nav-content" aria-hidden="true">
              {route.icon}
              {isActive && <span className="app-nav-label">{route.label}</span>}
            </span>
          </a>
        )
      })}
    </nav>
  )
}

export interface TopbarOverflowMenuItem {
  actionId?: string
  danger?: boolean
  disabled?: boolean
  icon: ReactNode
  key: string
  label: string
  onClick: () => void
  title?: string
}

interface TopbarOverflowMenuProps {
  ariaLabel: string
  items: TopbarOverflowMenuItem[]
  title?: string
}

export function TopbarOverflowMenu({
  ariaLabel,
  items,
  title = 'More actions',
}: TopbarOverflowMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const dismissMenu = useCallback(() => {
    setMenuOpen(false)
  }, [])

  useDismissibleLayer({
    enabled: menuOpen,
    onDismiss: dismissMenu,
    refs: [menuRef],
  })

  return (
    <div
      className="topbar-overflow-menu"
      ref={menuRef}
    >
      <button
        className="icon-button topbar-overflow-trigger"
        type="button"
        title={title}
        aria-label={ariaLabel}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((current) => !current)}
      >
        <MoreHorizontal size={16} />
      </button>
      {menuOpen && (
        <div className="topbar-overflow-popover" role="menu" aria-label={ariaLabel}>
          {items.map((item) => (
            <button
              key={item.key}
              className={item.danger ? 'danger' : ''}
              type="button"
              data-action-id={item.actionId || item.key}
              role="menuitem"
              title={item.title || item.label}
              disabled={item.disabled}
              onClick={() => {
                item.onClick()
                setMenuOpen(false)
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface TopbarAgentStatusPillProps {
  ariaLabel?: string
  label: string
  title: string
  tone?: TopbarStatusTone
}

export function TopbarAgentStatusPill({
  ariaLabel,
  label,
  title,
  tone = 'ready',
}: TopbarAgentStatusPillProps) {
  const Icon = tone === 'ready' ? null : AlertCircle

  return (
    <span
      className={`connection-pill ${tone} agent-status-pill`}
      data-testid={speakTestIds.activeAgentPill}
      title={title}
      aria-label={ariaLabel || title}
    >
      {Icon && <Icon size={15} />}
      <span className="connection-label">{label}</span>
    </span>
  )
}

interface AgentProfilePickerProps {
  className?: string
  disabled?: boolean
  editableName?: boolean
  inputRef?: Ref<HTMLInputElement>
  onCommitName?: () => void
  onNewProfile?: () => void
  onOpenSettings?: () => void
  onRenameProfile?: (name: string) => void
  onSelectProfile?: (profile: AgentConfigProfile) => void
  profiles: AgentConfigProfile[]
  searchable?: boolean
  selectedId?: string
  settingsDisabled?: boolean
  value: string
}

export function AgentProfilePicker({
  className = '',
  disabled = false,
  editableName = false,
  inputRef,
  onCommitName,
  onNewProfile,
  onOpenSettings,
  onRenameProfile,
  onSelectProfile,
  profiles,
  searchable = true,
  selectedId,
  settingsDisabled = false,
  value,
}: AgentProfilePickerProps) {
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [profileQuery, setProfileQuery] = useState('')
  const profileMenuRef = useRef<HTMLDivElement>(null)
  const selectedProfile =
    profiles.find((profile) => profile.id === selectedId) || null
  const query = profileQuery.trim().toLowerCase()
  const inputValue =
    profileMenuOpen && searchable && !editableName && onSelectProfile
      ? profileQuery
      : value
  const filteredProfiles =
    query && searchable && !editableName
      ? profiles.filter((profile) =>
          profile.name.toLowerCase().includes(query),
        )
      : profiles

  const dismissProfileMenu = useCallback(() => {
    setProfileMenuOpen(false)
  }, [])

  const dismissProfileMenuFromEscape = useCallback(() => {
    setProfileMenuOpen(false)
    if (editableName) profileMenuRef.current?.querySelector('input')?.blur()
  }, [editableName])

  useDismissibleLayer({
    enabled: profileMenuOpen,
    onDismiss: dismissProfileMenu,
    onEscapeDismiss: dismissProfileMenuFromEscape,
    refs: [profileMenuRef],
  })

  return (
    <div
      className={['agent-profile-picker', className].filter(Boolean).join(' ')}
      data-testid={speakTestIds.profilePicker}
      ref={profileMenuRef}
    >
      <label className="agent-profile-search">
        <input
          ref={inputRef}
          aria-label={
            editableName ? 'Agent configuration name' : 'Agent configuration'
          }
          aria-expanded={profileMenuOpen}
          autoCapitalize="words"
          autoComplete="off"
          autoCorrect="on"
          disabled={disabled || (!editableName && !onSelectProfile)}
          enterKeyHint={editableName || !searchable ? 'done' : 'search'}
          inputMode={editableName ? 'text' : searchable ? 'search' : 'none'}
          onChange={(event) => {
            if (editableName) {
              onRenameProfile?.(event.target.value)
              return
            }
            if (searchable && onSelectProfile) {
              setProfileQuery(event.target.value)
              setProfileMenuOpen(true)
            }
          }}
          onFocus={() => {
            if (!onSelectProfile) return
            setProfileQuery('')
            setProfileMenuOpen(true)
          }}
          onBlur={() => {
            if (editableName) onCommitName?.()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              if (editableName) event.currentTarget.blur()
            }
          }}
          placeholder={editableName ? 'Agent name' : 'Search agents...'}
          readOnly={!editableName && (!onSelectProfile || !searchable)}
          type="text"
          value={inputValue}
        />
        <button
          className="agent-profile-menu-button"
          type="button"
          data-action-id={speakActionIds.selectAgentProfile}
          title="Select agent profile"
          aria-label="Select agent profile"
          aria-expanded={profileMenuOpen}
          disabled={disabled || !onSelectProfile}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setProfileMenuOpen((current) => !current)}
        >
          <ChevronDown size={14} />
        </button>
      </label>
      {profileMenuOpen && onSelectProfile && (
        <div className="agent-profile-menu" role="listbox" aria-label="Agent profiles">
          {filteredProfiles.length === 0 ? (
            <p>No matching profiles.</p>
          ) : (
            filteredProfiles.map((profile) => (
              <button
                key={profile.id}
                className={[
                  'agent-profile-option',
                  profile.id === selectedProfile?.id ? 'selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                type="button"
                data-action-id={speakActionIds.selectAgentProfile}
                role="option"
                aria-selected={profile.id === selectedProfile?.id}
                onClick={() => {
                  onSelectProfile(profile)
                  setProfileQuery('')
                  setProfileMenuOpen(false)
                }}
              >
                <span>
                  <strong>{profile.name}</strong>
                  <em>{formatOperationalDateTime(profile.updatedAt, {
                    month: 'numeric',
                    day: 'numeric',
                    year: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    second: '2-digit',
                  })}</em>
                </span>
                {profile.id === selectedProfile?.id && (
                  <Check size={14} aria-hidden="true" />
                )}
              </button>
            ))
          )}
          {onNewProfile && (
            <button
              className="agent-profile-new"
              type="button"
              data-action-id={speakActionIds.addAgent}
              onClick={() => {
                onNewProfile()
                setProfileQuery('')
                setProfileMenuOpen(false)
              }}
            >
              <Plus size={14} aria-hidden="true" />
              <span>New agent</span>
            </button>
          )}
        </div>
      )}
      {onOpenSettings && (
        <button
          className="icon-button agent-profile-action"
          type="button"
          data-action-id={speakActionIds.openProfileSettings}
          disabled={disabled || settingsDisabled}
          title={`Open settings for ${value || 'agent'}`}
          aria-label={`Open settings for ${value || 'agent'}`}
          onClick={onOpenSettings}
        >
          <SlidersHorizontal size={14} />
        </button>
      )}
    </div>
  )
}
