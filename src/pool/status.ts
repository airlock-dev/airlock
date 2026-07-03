export type ProviderConnectionState = 'up' | 'connecting' | 'down' | 'auth_required';

export interface ProviderConnectionStatus {
  status: ProviderConnectionState;
  reason?: string;
}
