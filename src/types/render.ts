/**
 * Render spec types — mirrors the Rust RenderSpec enum.
 * These are the JSON structures returned by the shell engine.
 */

export interface TextSpec {
  type: 'text';
  content: string;
}

export interface ErrorSpec {
  type: 'error';
  message: string;
}

export interface TableSpec {
  type: 'table';
  headers: string[];
  rows: string[][];
}

export interface HostCallSpec {
  type: 'host_call';
  call_id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface VStackSpec {
  type: 'vstack';
  children: RenderSpec[];
}

export interface HStackSpec {
  type: 'hstack';
  children: RenderSpec[];
}

export interface HelpSpec {
  type: 'help';
  content: string;
}

export interface EntityCardSpec {
  type: 'entity_card';
  entity_id: string;
  icon: string;
  name: string;
  state: string;
  state_color: string;
  unit: string | null;
  domain: string;
  device_class: string | null;
  last_changed: string;
  attributes: [string, string][];
}

export interface KeyValueSpec {
  type: 'key_value';
  title: string | null;
  pairs: [string, string][];
}

export interface BadgeSpec {
  type: 'badge';
  label: string;
  color: string;
}

export interface CopyableSpec {
  type: 'copyable';
  content: string;
  label: string | null;
}

export interface SummarySpec {
  type: 'summary';
  content: string;
}

export interface AssistantSpec {
  type: 'assistant';
  response: string;
  agent: string;
  snippets: string[];
}

export interface SparklineSpec {
  type: 'sparkline';
  entity_id: string;
  name: string;
  unit: string | null;
  /** Data points: [timestamp_ms, value] */
  points: [number, number][];
  min: number;
  max: number;
  current: number;
}

export interface TimelineSpec {
  type: 'timeline';
  entity_id: string;
  name: string;
  /** Segments: [start_ms, end_ms, state, color] */
  segments: [number, number, string, string][];
  start_time: number;
  end_time: number;
}

export interface LogbookEntrySpec {
  when: string;
  name: string;
  state: string | null;
  message: string | null;
  entity_id: string | null;
  context_user: string | null;
  context_event: string | null;
  context_domain: string | null;
  context_service: string | null;
  context_entity: string | null;
  context_entity_name: string | null;
}

export interface LogbookSpec {
  type: 'logbook';
  entity_id: string;
  entries: LogbookEntrySpec[];
}

export interface TraceEntrySpec {
  run_id: string;
  automation: string | null;
  state: string;
  start: string;
  finish: string | null;
  trigger: string | null;
  last_step: string | null;
  execution: string | null;
  error: string | null;
}

export interface TraceListSpec {
  type: 'trace_list';
  automation_id: string | null;
  entries: TraceEntrySpec[];
}

export interface EChartsSpec {
  type: 'echarts';
  /** The full ECharts option object. */
  option: Record<string, unknown>;
  /** Optional chart title (shown above the chart). */
  title: string | null;
  /** Chart height in pixels (default 300). */
  height: number;
}

export interface CalendarEventEntrySpec {
  summary: string;
  start: string | null;
  end: string | null;
  description: string | null;
  location: string | null;
  all_day: boolean;
}

export interface CalendarEventsSpec {
  type: 'calendar_events';
  entity_id: string;
  entries: CalendarEventEntrySpec[];
}

export type RenderSpec =
  | TextSpec
  | ErrorSpec
  | TableSpec
  | HostCallSpec
  | VStackSpec
  | HStackSpec
  | HelpSpec
  | EntityCardSpec
  | KeyValueSpec
  | BadgeSpec
  | CopyableSpec
  | SummarySpec
  | AssistantSpec
  | SparklineSpec
  | TimelineSpec
  | LogbookSpec
  | TraceListSpec
  | EChartsSpec
  | CalendarEventsSpec;
