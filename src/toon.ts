import { encode } from '@toon-format/toon';

/**
 * Field extractor definitions for transforming Linear JSON into flat
 * TOON-friendly objects.
 */
export type FieldDef =
  | { type: 'field'; key: string; as?: string }
  | { type: 'pluck'; key: string; subkey: string; as?: string }
  | {
      type: 'joinArray';
      key: string;
      subkey: string;
      as?: string;
      empty?: string;
    }
  | { type: 'relativeTime'; key: string; as?: string }
  | { type: 'boolYesNo'; key: string; as?: string }
  | {
      type: 'mapEnum';
      key: string;
      map: Record<string, string>;
      fallback?: string;
      as?: string;
    }
  | { type: 'lower'; key: string; as?: string }
  | { type: 'custom'; as: string; fn: (item: any) => any };

export function field(key: string, as?: string): FieldDef {
  return { type: 'field', key, as };
}
export function pluck(key: string, subkey: string, as?: string): FieldDef {
  return { type: 'pluck', key, subkey, as };
}
export function joinArray(
  key: string,
  subkey: string,
  as?: string,
  empty = 'none',
): FieldDef {
  return { type: 'joinArray', key, subkey, as, empty };
}
export function relativeTime(key: string, as?: string): FieldDef {
  return { type: 'relativeTime', key, as };
}
export function boolYesNo(key: string, as?: string): FieldDef {
  return { type: 'boolYesNo', key, as };
}
export function mapEnum(
  key: string,
  map: Record<string, string>,
  fallback?: string,
  as?: string,
): FieldDef {
  return { type: 'mapEnum', key, map, fallback, as };
}
export function lower(key: string, as?: string): FieldDef {
  return { type: 'lower', key, as };
}
export function custom(as: string, fn: (item: any) => any): FieldDef {
  return { type: 'custom', as, fn };
}

export function extract(
  item: Record<string, any>,
  schema: FieldDef[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const def of schema) {
    const outputKey = def.as ?? ('key' in def ? def.key : def.as);
    switch (def.type) {
      case 'field':
        result[outputKey] = item[def.key] ?? null;
        break;
      case 'pluck':
        result[outputKey] =
          (item[def.key] as Record<string, unknown> | undefined)?.[
            def.subkey
          ] ?? null;
        break;
      case 'joinArray': {
        // Accept either a direct array or a Linear connection { nodes: [...] }
        const raw = item[def.key];
        const arr = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as Record<string, unknown> | null)?.nodes)
            ? ((raw as Record<string, unknown>).nodes as unknown[])
            : [];
        if (arr.length > 0) {
          result[outputKey] = arr
            .map((x: unknown) =>
              typeof x === 'string'
                ? x
                : (x as Record<string, unknown>)[def.subkey],
            )
            .join(',');
        } else {
          result[outputKey] = def.empty ?? 'none';
        }
        break;
      }
      case 'relativeTime':
        result[outputKey] = formatRelativeTime(
          item[def.key] as string | null | undefined,
        );
        break;
      case 'boolYesNo':
        result[outputKey] = item[def.key] ? 'yes' : 'no';
        break;
      case 'mapEnum': {
        const val = item[def.key];
        if (typeof val === 'string' && val !== '' && val in def.map) {
          result[outputKey] = def.map[val];
        } else {
          result[outputKey] = def.fallback ?? val ?? 'none';
        }
        break;
      }
      case 'lower':
        result[outputKey] =
          typeof item[def.key] === 'string'
            ? (item[def.key] as string).toLowerCase()
            : item[def.key];
        break;
      case 'custom':
        result[outputKey] = def.fn(item);
        break;
      default: {
        const _exhaustive: never = def;
        throw new Error(
          `Unknown field type: ${(_exhaustive as FieldDef).type}`,
        );
      }
    }
  }
  return result;
}

/** Render a labeled list of items as TOON. */
export function renderList(
  label: string,
  items: Record<string, any>[],
  schema: FieldDef[],
): string {
  const extracted = items.map((item) => extract(item, schema));
  return encode({ [label]: extracted });
}

/** Render a single labeled detail object as TOON. */
export function renderDetail(
  label: string,
  item: Record<string, any>,
  schema: FieldDef[],
): string {
  const extracted = extract(item, schema);
  return encode({ [label]: extracted });
}

/** Render help suggestions (manual formatting — encode() inlines primitive arrays). */
export function renderHelp(lines: string[]): string {
  if (lines.length === 0) return '';
  const indented = lines.map((l) => `  ${l}`).join('\n');
  return `help[${lines.length}]:\n${indented}`;
}

/** Render an error in TOON format. */
export function renderError(
  message: string,
  code: string,
  suggestions: string[] = [],
): string {
  const blocks = [encode({ error: message, code })];
  if (suggestions.length > 0) {
    blocks.push(renderHelp(suggestions));
  }
  return blocks.join('\n');
}

/** Combine multiple TOON blocks into a single output string. */
export function renderOutput(blocks: string[]): string {
  return blocks.filter(Boolean).join('\n');
}

/**
 * Truncate a long string for display. Returns the (possibly truncated) preview
 * plus a size note. AXI principle 3: never omit large fields entirely.
 */
export function truncateForDisplay(
  text: string | null | undefined,
  limit = 1000,
): { preview: string; total: number; truncated: boolean } {
  const total = text?.length ?? 0;
  if (!text || total <= limit) {
    return { preview: text ?? '', total, truncated: false };
  }
  return {
    preview: `${text.slice(0, limit)}...`,
    total,
    truncated: true,
  };
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (isNaN(then)) return 'unknown';
  const MS_PER_SECOND = 1000;
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / MS_PER_SECOND);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMon = Math.floor(diffDay / 30);
  if (diffMon < 12) return `${diffMon}mo ago`;
  const diffYr = Math.floor(diffMon / 12);
  return `${diffYr}y ago`;
}
