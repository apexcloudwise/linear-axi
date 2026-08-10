import { AxiError } from './errors.js';
import type { FieldDef } from './toon.js';

/**
 * Describes an extra field that can be requested via --fields.
 * `linearKey` is the Linear GraphQL field to add to the selection.
 * `def` is the FieldDef used to extract/format the value.
 */
export interface ExtraFieldSpec {
  linearKey: string;
  def: FieldDef;
}

export interface ParseFieldsResult {
  extraDefs: FieldDef[];
  extraLinearKeys: string[];
}

/**
 * Parse a --fields value (comma-separated field names), validate against the
 * available map, and return the extra FieldDefs and Linear GraphQL keys.
 *
 * Throws AxiError with VALIDATION_ERROR for any unknown field names.
 */
export function parseFields(
  fieldsArg: string | undefined,
  available: Record<string, ExtraFieldSpec>,
): ParseFieldsResult {
  if (fieldsArg === undefined) {
    return { extraDefs: [], extraLinearKeys: [] };
  }

  const requested = [
    ...new Set(
      fieldsArg
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean),
    ),
  ];

  const unknown = requested.filter((f) => !(f in available));
  if (unknown.length > 0) {
    const availableNames = Object.keys(available).sort().join(', ');
    throw new AxiError(
      `Unknown field(s): ${unknown.join(', ')}. Available: ${availableNames}`,
      'VALIDATION_ERROR',
    );
  }

  const extraDefs: FieldDef[] = [];
  const extraLinearKeys: string[] = [];

  for (const name of requested) {
    const spec = available[name];
    extraDefs.push(spec.def);
    extraLinearKeys.push(spec.linearKey);
  }

  return { extraDefs, extraLinearKeys };
}
