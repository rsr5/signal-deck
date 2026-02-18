/**
 * Entity card renderer dispatcher.
 *
 * Inspects `domain` on the EntityCardSpec and delegates to a
 * domain-specific renderer.  Falls back to the generic card for
 * any domain without a specialised renderer.
 */

import { type TemplateResult } from 'lit';
import type { EntityCardSpec } from '../types/index.js';
import { renderGenericCard } from './entities/generic.js';
import { renderLightCard } from './entities/light.js';
import { renderBinarySensorCard } from './entities/binary-sensor.js';
import { renderSensorCard } from './entities/sensor.js';
import { renderClimateCard } from './entities/climate.js';
import { renderMediaPlayerCard } from './entities/media-player.js';
import { renderPersonCard } from './entities/person.js';
import { renderCoverCard } from './entities/cover.js';
import { renderAutomationCard } from './entities/automation.js';
import { renderWeatherCard } from './entities/weather.js';
import { renderCalendarCard } from './entities/calendar.js';

/**
 * Render an entity card with domain-aware specialisation.
 */
export function renderEntityCard(spec: EntityCardSpec): TemplateResult {
  switch (spec.domain) {
    case 'light':
      return renderLightCard(spec);
    case 'binary_sensor':
      return renderBinarySensorCard(spec);
    case 'sensor':
      return renderSensorCard(spec);
    case 'climate':
      return renderClimateCard(spec);
    case 'media_player':
      return renderMediaPlayerCard(spec);
    case 'person':
      return renderPersonCard(spec);
    case 'cover':
      return renderCoverCard(spec);
    case 'automation':
    case 'script':
      return renderAutomationCard(spec);
    case 'weather':
      return renderWeatherCard(spec);
    case 'calendar':
      return renderCalendarCard(spec);
    default:
      return renderGenericCard(spec);
  }
}
