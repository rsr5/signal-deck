/**
 * Type declarations for Home Assistant's frontend API.
 * These are the types we get from the `hass` object injected by Lovelace.
 */

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  context: {
    id: string;
    parent_id: string | null;
    user_id: string | null;
  };
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  callWS: <T>(msg: Record<string, unknown>) => Promise<T>;
  callApi: <T>(method: string, path: string, data?: Record<string, unknown>) => Promise<T>;
  callService: (
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: Record<string, unknown>,
  ) => Promise<void>;
  language: string;
  locale: Record<string, unknown>;
}

export interface LovelaceCardConfig {
  type: string;
  [key: string]: unknown;
}

export interface SignalDeckConfig extends LovelaceCardConfig {
  title?: string;
  height?: string;
  show_analyst?: boolean;
  /** Force a specific HA conversation agent for the analyst (e.g. "conversation.claude_opus_conversation"). */
  agent_id?: string;
  /** Display mode: 'embedded' (default) renders inline, 'overlay' renders a tiny launcher button that opens a Quake-style console. */
  mode?: 'embedded' | 'overlay';
  /** Where the overlay appears: 'top' (drop-down), 'bottom' (slide-up), 'full' (covers viewport). Default: 'top'. */
  overlay_position?: 'top' | 'bottom' | 'full';
  /** Overlay height as CSS value for top/bottom positions (ignored for 'full'). Default: '50vh'. */
  overlay_height?: string;
}
