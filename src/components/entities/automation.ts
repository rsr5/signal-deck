/**
 * Automation / Script entity card — last triggered, state.
 */

import { html, nothing, type TemplateResult } from 'lit';
import type { EntityCardSpec } from '../../types/index.js';
import {
  renderCardHeader,
  renderCardMeta,
  renderAttrsTable,
  renderBadge,
  attrStr,
  attrsExcluding,
} from './helpers.js';

const HANDLED_ATTRS = [
  'last_triggered', 'current', 'mode', 'id',
];

export function renderAutomationCard(spec: EntityCardSpec): TemplateResult {
  const stateClass = `state-${spec.state_color}`;
  const lastTriggered = attrStr(spec, 'last_triggered');
  const mode = attrStr(spec, 'mode');
  const current = attrStr(spec, 'current');

  const remaining = attrsExcluding(spec, HANDLED_ATTRS);

  return html`
    <div class="entity-card">
      ${renderCardHeader(spec)}

      <div class="entity-card-state">
        <span class="entity-card-state-value ${stateClass}">${spec.state}</span>
      </div>

      <div class="entity-automation-details">
        ${lastTriggered
          ? html`<div class="entity-automation-triggered">
              <span class="entity-automation-triggered-label">Last triggered:</span>
              <span class="entity-automation-triggered-value">${formatRelative(lastTriggered)}</span>
            </div>`
          : nothing}

        <div class="entity-automation-badges">
          ${mode ? renderBadge(`mode: ${mode}`, 'badge-auto-mode') : nothing}
          ${current && current !== '0'
            ? renderBadge(`${current} running`, 'badge-auto-running')
            : nothing}
        </div>
      </div>

      ${renderCardMeta(spec)}
      ${renderAttrsTable(remaining)}
    </div>
  `;
}

/** Format an ISO timestamp as a relative "Xh ago" string. */
function formatRelative(iso: string): string {
  if (!iso || iso === 'None' || iso === 'none') return 'never';
  try {
    const ts = new Date(iso).getTime();
    if (isNaN(ts)) return iso;
    const diffMs = Date.now() - ts;
    if (diffMs < 0) return iso;

    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return `${days}d ago`;
  } catch {
    return iso;
  }
}
