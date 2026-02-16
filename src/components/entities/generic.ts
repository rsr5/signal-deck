/**
 * Generic entity card — the fallback renderer.
 * Shows the same layout as the original entity card.
 */

import { html, nothing, type TemplateResult } from 'lit';
import type { EntityCardSpec } from '../../types/index.js';
import { renderCardHeader, renderCardMeta, renderAttrsTable } from './helpers.js';

export function renderGenericCard(spec: EntityCardSpec): TemplateResult {
  const stateClass = `state-${spec.state_color}`;
  const stateDisplay = spec.unit ? `${spec.state}` : spec.state;

  return html`
    <div class="entity-card">
      ${renderCardHeader(spec)}
      <div class="entity-card-state">
        <span class="entity-card-state-value ${stateClass}">${stateDisplay}</span>
        ${spec.unit ? html`<span class="entity-card-state-unit">${spec.unit}</span>` : nothing}
      </div>
      ${renderCardMeta(spec)}
      ${renderAttrsTable(spec.attributes)}
    </div>
  `;
}
