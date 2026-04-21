export type ViewState =
  | { type: 'menu' }
  | { type: 'help' }
  | { type: 'marketplace-menu' }
  | { type: 'marketplace-list' }
  | { type: 'validate'; path: string }
  | {
      type: 'browse-marketplace'
      targetMarketplace?: string
      targetPlugin?: string
    }
  | { type: 'discover-plugins'; targetPlugin?: string }
  | {
      type: 'manage-plugins'
      targetPlugin?: string
      targetMarketplace?: string
      action?: 'uninstall' | 'enable' | 'disable'
    }
  | { type: 'add-marketplace'; initialValue?: string }
  | {
      type: 'manage-marketplaces'
      targetMarketplace?: string
      action?: 'remove' | 'update'
    }

export type PluginSettingsProps = {
  viewState: ViewState
  onComplete: () => void
  args: string[]
  showMcpRedirectMessage?: boolean
}
