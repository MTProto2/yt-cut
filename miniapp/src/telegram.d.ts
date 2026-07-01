interface TelegramWebApp {
  ready(): void
  expand(): void
  initData: string
  colorScheme: 'light' | 'dark'
  showAlert(message: string, callback?: () => void): void
  shareMessage(msgId: string, callback?: (success: boolean) => void): void
  openLink(url: string, options?: { try_instant_view?: boolean }): void
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void
    notificationOccurred(type: 'error' | 'success' | 'warning'): void
    selectionChanged(): void
  }
  MainButton: {
    text: string
    isVisible: boolean
    setText(text: string): void
    show(): void
    hide(): void
    enable(): void
    disable(): void
    showProgress(leaveActive?: boolean): void
    hideProgress(): void
    onClick(handler: () => void): void
    offClick(handler: () => void): void
  }
  // Bot API 7.10+ — may be absent on older Telegram clients.
  SecondaryButton?: {
    text: string
    isVisible: boolean
    setText(text: string): void
    show(): void
    hide(): void
    enable(): void
    disable(): void
    showProgress(leaveActive?: boolean): void
    hideProgress(): void
    onClick(handler: () => void): void
    offClick(handler: () => void): void
    setParams(params: {
      text?: string
      color?: string
      textColor?: string
      hasShineEffect?: boolean
      position?: 'left' | 'right' | 'top' | 'bottom'
      isActive?: boolean
      isVisible?: boolean
    }): void
  }
}

interface Window {
  Telegram?: { WebApp: TelegramWebApp }
}
