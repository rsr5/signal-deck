/**
 * Host functions — the TypeScript side of the ABI boundary.
 * These fulfill host call requests from the Rust shell engine.
 */

import type { HomeAssistant, HassEntity, RenderSpec } from '../types/index.js';

export interface HostCallResult {
  data: string; // JSON string to pass back to Rust
}

/**
 * Fulfill a host call request from the engine.
 * Routes the method to the appropriate HA API call.
 */
export async function fulfillHostCall(
  hass: HomeAssistant,
  method: string,
  params: Record<string, unknown>,
): Promise<HostCallResult> {
  switch (method) {
    case 'get_states':
      return getStates(hass, params);
    case 'get_state':
      return getState(hass, params);
    case 'find_entities':
      return findEntities(hass, params);
    case 'get_history':
      return getHistory(hass, params);
    case 'get_statistics':
      return getStatistics(hass, params);
    case 'get_diff':
      return getDiff(hass, params);
    case 'get_area_entities':
      return getAreaEntities(hass, params);
    case 'get_areas':
      return getAreas(hass);
    case 'conversation_process':
      return conversationProcess(hass, params);
    case 'get_logbook':
      return getLogbook(hass, params);
    case 'render_template':
      return renderTemplate(hass, params);
    case 'get_trace':
      return getTrace(hass, params);
    case 'list_traces':
      return listTraces(hass);
    case 'get_devices':
      return getDevices(hass, params);
    case 'get_entity_entry':
      return getEntityEntry(hass, params);
    case 'check_config':
      return checkConfig(hass);
    case 'get_error_log':
      return getErrorLog(hass);
    case 'get_datetime':
      return getDatetime(hass);
    case 'get_services':
      return getServices(hass, params);
    case 'call_service':
      return callService(hass, params);
    case 'get_events':
      return getCalendarEvents(hass, params);
    default:
      return { data: JSON.stringify({ error: `Unknown host method: ${method}` }) };
  }
}

/** Get all states, optionally filtered by domain. */
function getStates(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): HostCallResult {
  const domain = params.domain as string | undefined;
  const states = Object.values(hass.states);

  const filtered = domain ? states.filter((s) => s.entity_id.startsWith(`${domain}.`)) : states;

  // Sort by entity_id for consistent output.
  filtered.sort((a, b) => a.entity_id.localeCompare(b.entity_id));

  return { data: JSON.stringify(filtered) };
}

/** Get a single entity state. Supports attrs_only flag for %attrs command. */
function getState(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): HostCallResult {
  const entityId = params.entity_id as string;
  const attrsOnly = params.attrs_only as boolean | undefined;
  const state = hass.states[entityId];

  if (!state) {
    return { data: JSON.stringify({ error: `Entity not found: ${entityId}` }) };
  }

  if (attrsOnly) {
    return { data: JSON.stringify({ __attrs_only: true, entity: state }) };
  }

  return { data: JSON.stringify(state) };
}

/** Find entities matching a glob pattern. */
function findEntities(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): HostCallResult {
  const pattern = params.pattern as string;
  const states = Object.values(hass.states);

  // Convert glob pattern to regex.
  const regexStr = '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  const regex = new RegExp(regexStr, 'i');

  const matches = states
    .filter((s) => regex.test(s.entity_id))
    .sort((a, b) => a.entity_id.localeCompare(b.entity_id));

  return { data: JSON.stringify(matches) };
}

/** Get entity history via HA WebSocket. */
async function getHistory(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): Promise<HostCallResult> {
  const entityId = params.entity_id as string;
  const hours = (params.hours as number) || 6;

  const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  try {
    const result = await hass.callApi<HassEntity[][]>(
      'GET',
      `history/period/${startTime}?filter_entity_id=${entityId}&minimal_response&no_attributes`,
    );
    return { data: JSON.stringify(result) };
  } catch (e) {
    return { data: JSON.stringify({ error: `History fetch failed: ${e}` }) };
  }
}

// ---------------------------------------------------------------------------
// Calendar events — "what events does calendar X have in this time window?"
// ---------------------------------------------------------------------------

/** Fetch calendar events for an entity over a time period. */
async function getCalendarEvents(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): Promise<HostCallResult> {
  const entityId = params.entity_id as string;
  const hours = (params.hours as number) || 24 * 14; // default 14 days

  const start = new Date(Date.now());
  const end = new Date(Date.now() + hours * 60 * 60 * 1000);

  const startStr = start.toISOString();
  const endStr = end.toISOString();

  try {
    const result = await hass.callApi<Array<{
      summary: string;
      start: { dateTime?: string; date?: string };
      end: { dateTime?: string; date?: string };
      description?: string;
      location?: string;
      uid?: string;
      recurrence_id?: string;
      rrule?: string;
    }>>(
      'GET',
      `calendars/${entityId}?start=${encodeURIComponent(startStr)}&end=${encodeURIComponent(endStr)}`,
    );

    // Flatten start/end to simple strings for easier consumption.
    const events = (result ?? []).map((ev) => ({
      summary: ev.summary,
      start: ev.start?.dateTime ?? ev.start?.date ?? null,
      end: ev.end?.dateTime ?? ev.end?.date ?? null,
      description: ev.description ?? null,
      location: ev.location ?? null,
    }));

    return { data: JSON.stringify(events) };
  } catch (e) {
    return { data: JSON.stringify({ error: `Calendar events fetch failed: ${e}` }) };
  }
}

/** Get long-term statistics via HA WebSocket (recorder). */
async function getStatistics(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): Promise<HostCallResult> {
  const entityId = params.entity_id as string;
  const hours = (params.hours as number) || 24;
  const period = (params.period as string) || 'hour';

  const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  const endTime = new Date();

  try {
    const result = await hass.callWS<Record<string, StatisticValue[]>>({
      type: 'recorder/statistics_during_period',
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      statistic_ids: [entityId],
      period,
      types: ['mean', 'min', 'max', 'state', 'sum', 'change'],
    });
    return { data: JSON.stringify(result) };
  } catch (e) {
    return { data: JSON.stringify({ error: `Statistics fetch failed: ${e}` }) };
  }
}

interface StatisticValue {
  start: number;
  end: number;
  mean?: number | null;
  min?: number | null;
  max?: number | null;
  state?: number | null;
  sum?: number | null;
  change?: number | null;
  last_reset?: number | null;
}

/** Compare two entities side-by-side. */
function getDiff(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): HostCallResult {
  const entityA = params.entity_a as string;
  const entityB = params.entity_b as string;
  const stateA = hass.states[entityA];
  const stateB = hass.states[entityB];

  if (!stateA) {
    return { data: JSON.stringify({ error: `Entity not found: ${entityA}` }) };
  }
  if (!stateB) {
    return { data: JSON.stringify({ error: `Entity not found: ${entityB}` }) };
  }

  return {
    data: JSON.stringify({
      __diff: true,
      entity_a: stateA,
      entity_b: stateB,
    }),
  };
}

/** Get all areas (rooms) in the HA instance. */
async function getAreas(hass: HomeAssistant): Promise<HostCallResult> {
  try {
    const areas = await hass.callWS<Array<{ area_id: string; name: string; floor_id?: string; labels?: string[] }>>({
      type: 'config/area_registry/list',
    });

    // Return just area_id + name, sorted alphabetically.
    const result = areas
      .map((a) => ({ area_id: a.area_id, name: a.name, floor_id: a.floor_id ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { data: JSON.stringify(result) };
  } catch (e) {
    return { data: JSON.stringify({ error: `Failed to fetch areas: ${e}` }) };
  }
}

/** Get all entities in a given area/room, by name or area_id. */
async function getAreaEntities(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): Promise<HostCallResult> {
  const areaQuery = (params.area as string) ?? '';

  try {
    // Step 1: Find the area by name or ID.
    const areas = await hass.callWS<Array<{ area_id: string; name: string }>>({
      type: 'config/area_registry/list',
    });

    // Fuzzy match: case-insensitive, also match if query is a substring.
    const queryLower = areaQuery.toLowerCase().replace(/[_-]/g, ' ');
    let match = areas.find((a) => a.area_id === areaQuery);
    if (!match) {
      match = areas.find((a) => a.name.toLowerCase() === queryLower);
    }
    if (!match) {
      match = areas.find((a) => a.name.toLowerCase().includes(queryLower));
    }
    if (!match) {
      match = areas.find((a) => a.area_id.replace(/_/g, ' ').includes(queryLower));
    }

    if (!match) {
      const available = areas.map((a) => a.name).join(', ');
      return {
        data: JSON.stringify({
          error: `Area not found: "${areaQuery}". Available areas: ${available}`,
        }),
      };
    }

    // Step 2: Use extract_from_target to get all entity IDs in this area.
    const extracted = await hass.callWS<{
      referenced_entities: string[];
      referenced_devices: string[];
    }>({
      type: 'extract_from_target',
      target: { area_id: [match.area_id] },
    });

    // Step 3: Collect full state objects for the referenced entities.
    const entities: HassEntity[] = extracted.referenced_entities
      .map((eid) => hass.states[eid])
      .filter((s): s is HassEntity => !!s)
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id));

    return {
      data: JSON.stringify({
        __area: true,
        area_id: match.area_id,
        area_name: match.name,
        entities,
      }),
    };
  } catch (e) {
    return { data: JSON.stringify({ error: `Failed to fetch area entities: ${e}` }) };
  }
}

// ---------------------------------------------------------------------------
// Logbook — "what happened to entity X in the last N hours?"
// ---------------------------------------------------------------------------

/** Fetch logbook entries for an entity over a time period. */
async function getLogbook(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): Promise<HostCallResult> {
  const entityId = params.entity_id as string;
  const hours = (params.hours as number) || 6;

  const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const endTime = new Date().toISOString();

  try {
    const result = await hass.callApi<Array<{
      when: string;
      name: string;
      message?: string;
      entity_id?: string;
      state?: string;
      domain?: string;
      context_user_id?: string;
      context_event_type?: string;
      context_domain?: string;
      context_service?: string;
      context_entity_id?: string;
      context_entity_id_name?: string;
      context_name?: string;
    }>>(
      'GET',
      `logbook/${startTime}?entity=${entityId}&end_time=${endTime}`,
    );

    // Simplify entries for readability.
    const entries = (result ?? []).map((e) => ({
      when: e.when,
      name: e.name,
      state: e.state ?? null,
      message: e.message ?? null,
      entity_id: e.entity_id ?? null,
      // Context tells us WHY the change happened.
      context_user: e.context_name ?? e.context_user_id ?? null,
      context_event: e.context_event_type ?? null,
      context_domain: e.context_domain ?? null,
      context_service: e.context_service ?? null,
      context_entity: e.context_entity_id ?? null,
      context_entity_name: e.context_entity_id_name ?? null,
    }));

    return { data: JSON.stringify(entries) };
  } catch (e) {
    return { data: JSON.stringify({ error: `Logbook fetch failed: ${e}` }) };
  }
}

// ---------------------------------------------------------------------------
// Template — render Jinja2 templates against live state
// ---------------------------------------------------------------------------

/** Render a Jinja2 template against the current HA state. */
async function renderTemplate(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): Promise<HostCallResult> {
  const template = params.template as string;

  try {
    const result = await hass.callApi<string>(
      'POST',
      'template',
      { template },
    );
    return { data: JSON.stringify({ result }) };
  } catch (e) {
    return { data: JSON.stringify({ error: `Template render failed: ${e}` }) };
  }
}

// ---------------------------------------------------------------------------
// Automation traces — see WHY an automation fired or failed
// ---------------------------------------------------------------------------

/** Get traces for a specific automation. */
async function getTrace(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): Promise<HostCallResult> {
  const automationId = params.automation_id as string;

  // Extract the object_id from the full entity_id (automation.xyz → xyz).
  const objectId = automationId.startsWith('automation.')
    ? automationId.slice('automation.'.length)
    : automationId;

  try {
    const traces = await hass.callWS<Array<{
      run_id: string;
      state: string;
      timestamp: { start: string; finish?: string };
      domain: string;
      item_id: string;
      script_execution?: string;
      result?: Record<string, unknown>;
      error?: string;
      trigger?: string;
      last_step?: string;
      context: { id: string; parent_id?: string; user_id?: string };
    }>>({
      type: 'trace/list',
      domain: 'automation',
      item_id: objectId,
    });

    // Return simplified trace summaries.
    const summaries = (traces ?? []).map((t) => ({
      run_id: t.run_id,
      state: t.state,
      start: t.timestamp?.start,
      finish: t.timestamp?.finish ?? null,
      trigger: t.trigger ?? null,
      last_step: t.last_step ?? null,
      execution: t.script_execution ?? null,
      error: t.error ?? null,
    }));

    return { data: JSON.stringify(summaries) };
  } catch (e) {
    return { data: JSON.stringify({ error: `Trace fetch failed: ${e}` }) };
  }
}

/** List all recent automation traces across all automations. */
async function listTraces(hass: HomeAssistant): Promise<HostCallResult> {
  try {
    const traces = await hass.callWS<Array<{
      run_id: string;
      state: string;
      timestamp: { start: string; finish?: string };
      domain: string;
      item_id: string;
      script_execution?: string;
      error?: string;
      trigger?: string;
      last_step?: string;
    }>>({
      type: 'trace/list',
      domain: 'automation',
    });

    const summaries = (traces ?? []).map((t) => ({
      run_id: t.run_id,
      automation: `automation.${t.item_id}`,
      state: t.state,
      start: t.timestamp?.start,
      finish: t.timestamp?.finish ?? null,
      trigger: t.trigger ?? null,
      last_step: t.last_step ?? null,
      execution: t.script_execution ?? null,
      error: t.error ?? null,
    }));

    return { data: JSON.stringify(summaries) };
  } catch (e) {
    return { data: JSON.stringify({ error: `Trace list failed: ${e}` }) };
  }
}

// ---------------------------------------------------------------------------
// Device & entity registry — integration, firmware, connection status
// ---------------------------------------------------------------------------

/** Get all devices, optionally filtered by keyword search. */
async function getDevices(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): Promise<HostCallResult> {
  const query = (params.query as string | undefined)?.toLowerCase();

  try {
    const devices = await hass.callWS<Array<{
      id: string;
      name: string;
      name_by_user?: string;
      manufacturer?: string;
      model?: string;
      sw_version?: string;
      hw_version?: string;
      area_id?: string;
      config_entries: string[];
      connections: Array<[string, string]>;
      identifiers: Array<[string, string]>;
      disabled_by?: string;
      entry_type?: string;
    }>>({
      type: 'config/device_registry/list',
    });

    let filtered = devices ?? [];

    // Filter by keyword if provided.
    if (query) {
      filtered = filtered.filter((d) => {
        const searchable = [
          d.name,
          d.name_by_user,
          d.manufacturer,
          d.model,
          d.id,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return searchable.includes(query);
      });
    }

    // Simplify for readability.
    const result = filtered.map((d) => ({
      id: d.id,
      name: d.name_by_user || d.name,
      manufacturer: d.manufacturer ?? null,
      model: d.model ?? null,
      sw_version: d.sw_version ?? null,
      hw_version: d.hw_version ?? null,
      area_id: d.area_id ?? null,
      disabled_by: d.disabled_by ?? null,
      integrations: d.config_entries,
    }));

    return { data: JSON.stringify(result) };
  } catch (e) {
    return { data: JSON.stringify({ error: `Device registry fetch failed: ${e}` }) };
  }
}

/** Get entity registry entry for a specific entity — shows integration, device, platform. */
async function getEntityEntry(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): Promise<HostCallResult> {
  const entityId = params.entity_id as string;

  try {
    const entries = await hass.callWS<Array<{
      entity_id: string;
      name?: string;
      original_name?: string;
      platform: string;
      config_entry_id?: string;
      device_id?: string;
      area_id?: string;
      disabled_by?: string;
      hidden_by?: string;
      icon?: string;
      unique_id: string;
      entity_category?: string;
    }>>({
      type: 'config/entity_registry/list',
    });

    const entry = (entries ?? []).find((e) => e.entity_id === entityId);
    if (!entry) {
      return { data: JSON.stringify({ error: `Entity not in registry: ${entityId}` }) };
    }

    // Also fetch device info if available.
    let deviceInfo = null;
    if (entry.device_id) {
      const devices = await hass.callWS<Array<{
        id: string;
        name: string;
        manufacturer?: string;
        model?: string;
        sw_version?: string;
        area_id?: string;
        config_entries: string[];
      }>>({
        type: 'config/device_registry/list',
      });
      const dev = (devices ?? []).find((d) => d.id === entry.device_id);
      if (dev) {
        deviceInfo = {
          id: dev.id,
          name: dev.name,
          manufacturer: dev.manufacturer ?? null,
          model: dev.model ?? null,
          sw_version: dev.sw_version ?? null,
          area_id: dev.area_id ?? null,
        };
      }
    }

    // Include current state.
    const currentState = hass.states[entityId];

    return {
      data: JSON.stringify({
        entity_id: entry.entity_id,
        name: entry.name ?? entry.original_name ?? null,
        platform: entry.platform,
        config_entry_id: entry.config_entry_id ?? null,
        device_id: entry.device_id ?? null,
        area_id: entry.area_id ?? null,
        disabled_by: entry.disabled_by ?? null,
        hidden_by: entry.hidden_by ?? null,
        icon: entry.icon ?? null,
        unique_id: entry.unique_id,
        entity_category: entry.entity_category ?? null,
        device: deviceInfo,
        state: currentState?.state ?? null,
        attributes: currentState?.attributes ?? null,
      }),
    };
  } catch (e) {
    return { data: JSON.stringify({ error: `Entity registry fetch failed: ${e}` }) };
  }
}

// ---------------------------------------------------------------------------
// Config validation & error log
// ---------------------------------------------------------------------------

/** Check HA configuration validity. */
async function checkConfig(hass: HomeAssistant): Promise<HostCallResult> {
  try {
    const result = await hass.callApi<{ result: string; errors?: string }>(
      'POST',
      'config/core/check_config',
    );
    return { data: JSON.stringify(result) };
  } catch (e) {
    return { data: JSON.stringify({ error: `Config check failed: ${e}` }) };
  }
}

/** Fetch the HA error log. */
async function getErrorLog(hass: HomeAssistant): Promise<HostCallResult> {
  try {
    const result = await hass.callApi<string>(
      'GET',
      'error_log',
    );
    // The error log is a plain text string — split into lines and return last 50.
    const lines = (result ?? '').split('\n');
    const recent = lines.slice(-50);
    return { data: JSON.stringify({ log: recent.join('\n'), total_lines: lines.length }) };
  } catch (e) {
    return { data: JSON.stringify({ error: `Error log fetch failed: ${e}` }) };
  }
}

// ---------------------------------------------------------------------------
// Datetime — current date/time from the browser
// ---------------------------------------------------------------------------

/** Get the current date, time, timezone, and day of week. */
function getDatetime(_hass: HomeAssistant): HostCallResult {
  const now = new Date();
  const iso = now.toISOString();
  const local = now.toLocaleString();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayOfWeek = dayNames[now.getDay()];
  const date = now.toLocaleDateString('en-CA'); // YYYY-MM-DD
  const time = now.toLocaleTimeString('en-GB', { hour12: false }); // HH:MM:SS
  const epochMs = now.getTime();

  return {
    data: JSON.stringify({
      iso,
      local,
      date,
      time,
      timezone: tz,
      day_of_week: dayOfWeek,
      epoch_ms: epochMs,
      ha_timezone: (_hass as unknown as Record<string, unknown>).config
        ? (((_hass as unknown as Record<string, unknown>).config as Record<string, unknown>)?.time_zone as string ?? tz)
        : tz,
    }),
  };
}

// ---------------------------------------------------------------------------
// Services — list & call HA services
// ---------------------------------------------------------------------------

/** Execute a service call.
 *  This function is only called *after* the TypeScript confirmation gate
 *  has been approved by the user. */
async function callService(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): Promise<HostCallResult> {
  const domain = params.domain as string | undefined;
  const service = params.service as string | undefined;
  const serviceData = { ...((params.service_data ?? params.data ?? {}) as Record<string, unknown>) };

  if (!domain || !service) {
    return { data: JSON.stringify({ error: 'call_service requires domain and service' }) };
  }

  // HA's callService expects entity_id / device_id / area_id in a
  // separate `target` parameter rather than in `serviceData`.
  const target: Record<string, unknown> = {};
  for (const key of ['entity_id', 'device_id', 'area_id'] as const) {
    if (serviceData[key] !== undefined) {
      target[key] = serviceData[key];
      delete serviceData[key];
    }
  }

  try {
    await hass.callService(
      domain,
      service,
      serviceData,
      Object.keys(target).length > 0 ? target : undefined,
    );
    return {
      data: JSON.stringify({
        success: true,
        domain,
        service,
        service_data: serviceData,
        ...(Object.keys(target).length > 0 ? { target } : {}),
      }),
    };
  } catch (e) {
    return {
      data: JSON.stringify({
        error: `Service call failed: ${e}`,
        domain,
        service,
      }),
    };
  }
}

/** List available services, optionally filtered by domain. */
async function getServices(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): Promise<HostCallResult> {
  const domainFilter = params.domain as string | undefined;

  try {
    // hass.services is available as a property on the hass object:
    // Record<domain, Record<service, { name, description, fields, target }>>
    const hassAny = hass as unknown as Record<string, unknown>;
    let allServices = hassAny.services as Record<string, Record<string, {
      name?: string;
      description?: string;
      fields?: Record<string, { name?: string; description?: string; required?: boolean; example?: unknown }>;
      target?: unknown;
    }>> | undefined;

    // Fallback: fetch via WebSocket if hass.services isn't available.
    if (!allServices) {
      allServices = await hass.callWS<typeof allServices>({
        type: 'get_services',
      });
    }

    if (!allServices) {
      return { data: JSON.stringify({ error: 'No services available' }) };
    }

    // Build a flat list of services with domain, service name, description, and fields.
    const entries: Array<{
      domain: string;
      service: string;
      name: string;
      description: string;
      fields: string[];
    }> = [];

    const domains = domainFilter ? [domainFilter] : Object.keys(allServices).sort();

    for (const domain of domains) {
      const domainServices = allServices[domain];
      if (!domainServices) continue;

      for (const [svcName, svcDef] of Object.entries(domainServices)) {
        const fieldNames = svcDef.fields ? Object.keys(svcDef.fields) : [];
        entries.push({
          domain,
          service: svcName,
          name: svcDef.name ?? svcName,
          description: svcDef.description ?? '',
          fields: fieldNames,
        });
      }
    }

    return { data: JSON.stringify(entries) };
  } catch (e) {
    return { data: JSON.stringify({ error: `Services fetch failed: ${e}` }) };
  }
}

/** Ask Claude via HA Conversation integration. */
async function conversationProcess(
  hass: HomeAssistant,
  params: Record<string, unknown>,
): Promise<HostCallResult> {
  const question = params.text as string;
  const context = params.context as string | undefined;

  // Build the prompt with shell context if available.
  const fullText = context
    ? `${context}\n\nUser question: ${question}`
    : question;

  try {
    // Find a conversation agent — prefer Claude if available.
    const agentId = findConversationAgent(hass);

    const response = await hass.callWS<{
      response: {
        speech: { plain: { speech: string } };
        response_type: string;
      };
    }>({
      type: 'conversation/process',
      text: fullText,
      ...(agentId ? { agent_id: agentId } : {}),
    });

    const speech = response?.response?.speech?.plain?.speech ?? '(no response)';

    return {
      data: JSON.stringify({
        __conversation: true,
        response: speech,
        agent_id: agentId ?? 'default',
      }),
    };
  } catch (e) {
    return {
      data: JSON.stringify({
        __conversation: true,
        response: `Conversation error: ${e}`,
        agent_id: 'error',
      }),
    };
  }
}

/** Find the best conversation agent entity. Prefers Claude/Anthropic. */
function findConversationAgent(hass: HomeAssistant): string | null {
  const entities = Object.keys(hass.states).filter((id) =>
    id.startsWith('conversation.'),
  );

  // Prefer Claude / Anthropic.
  const claude = entities.find(
    (id) => id.includes('claude') || id.includes('anthropic'),
  );
  if (claude) return claude;

  // Fall back to any non-default conversation agent.
  const nonDefault = entities.find((id) => id !== 'conversation.home_assistant');
  if (nonDefault) return nonDefault;

  // Use default HA conversation as last resort.
  return entities.length > 0 ? entities[0] : null;
}

/**
 * Check if a render spec is a host call that needs fulfilling.
 */
export function isHostCall(spec: RenderSpec): spec is Extract<RenderSpec, { type: 'host_call' }> {
  return spec.type === 'host_call';
}
