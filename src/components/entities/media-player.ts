/**
 * Media player entity card — now-playing layout with volume bar.
 */

import { html, nothing, type TemplateResult } from 'lit';
import type { EntityCardSpec } from '../../types/index.js';
import {
  renderCardHeader,
  renderCardMeta,
  renderAttrsTable,
  renderBar,
  renderBadge,
  attrNum,
  attrStr,
  attrsExcluding,
} from './helpers.js';

const HANDLED_ATTRS = [
  'media_title', 'media_artist', 'media_album_name', 'media_content_type',
  'volume_level', 'is_volume_muted', 'source', 'source_list',
  'sound_mode', 'sound_mode_list', 'media_duration', 'media_position',
  'media_position_updated_at', 'app_name',
];

/** Playback state → icon */
const PLAYBACK_ICON: Record<string, string> = {
  playing: '▶',
  paused: '⏸',
  idle: '⏹',
  standby: '⏹',
  off: '⏹',
  buffering: '⏳',
};

export function renderMediaPlayerCard(spec: EntityCardSpec): TemplateResult {
  const stateClass = `state-${spec.state_color}`;

  const title = attrStr(spec, 'media_title');
  const artist = attrStr(spec, 'media_artist');
  const album = attrStr(spec, 'media_album_name');
  const volumeLevel = attrNum(spec, 'volume_level');
  const isMuted = attrStr(spec, 'is_volume_muted') === 'True';
  const source = attrStr(spec, 'source');
  const appName = attrStr(spec, 'app_name');
  const playbackIcon = PLAYBACK_ICON[spec.state] ?? '⏹';

  const volumePct = volumeLevel !== undefined ? Math.round(volumeLevel * 100) : undefined;

  const remaining = attrsExcluding(spec, HANDLED_ATTRS);

  return html`
    <div class="entity-card">
      ${renderCardHeader(spec)}

      <div class="entity-media-state">
        <span class="entity-media-playback ${stateClass}">${playbackIcon}</span>
        <span class="entity-media-status ${stateClass}">${spec.state}</span>
      </div>

      ${title
        ? html`
          <div class="entity-media-nowplaying">
            <div class="entity-media-title">${title}</div>
            ${artist ? html`<div class="entity-media-artist">${artist}</div>` : nothing}
            ${album ? html`<div class="entity-media-album">${album}</div>` : nothing}
          </div>
        `
        : nothing}

      ${volumePct !== undefined
        ? renderBar(
            volumePct,
            100,
            isMuted ? 'var(--sd-dim)' : 'var(--sd-accent)',
            isMuted ? '󰖁 Muted' : '󰕾 Volume',
          )
        : nothing}

      <div class="entity-media-badges">
        ${source ? renderBadge(`󰓃 ${source}`, 'badge-media-source') : nothing}
        ${appName ? renderBadge(appName, 'badge-media-app') : nothing}
      </div>

      ${renderCardMeta(spec)}
      ${renderAttrsTable(remaining)}
    </div>
  `;
}
