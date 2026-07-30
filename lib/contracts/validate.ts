/**
 * Runtime validation against the JSON Schemas in `contracts/`.
 *
 * The schemas are imported rather than read from disk so they are bundled into
 * the serverless function — a validator that silently cannot find its schema is
 * worse than no validator.
 *
 * Used by the ML ingest endpoint. Lane C writes these rows from a different
 * language, on a different schedule, and the numbers end up driving auto-rollback,
 * so "it looked like a fit" is not good enough: a band with `low > expected` or a
 * missing `model_version` has to be rejected at the door.
 */

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import elasticityFitSchema from '../../contracts/elasticity_fit.schema.json';
import expectedBandSchema from '../../contracts/expected_band.schema.json';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validators = new Map<string, ValidateFunction>();

function validatorFor(key: string, schema: object): ValidateFunction {
  const existing = validators.get(key);
  if (existing) return existing;
  const compiled = ajv.compile(schema);
  validators.set(key, compiled);
  return compiled;
}

export interface ValidationProblem {
  index: number;
  path: string;
  message: string;
}

export interface ValidationOutcome<T> {
  valid: T[];
  problems: ValidationProblem[];
}

function describe(errors: ErrorObject[] | null | undefined, index: number): ValidationProblem[] {
  return (errors ?? []).map((error) => ({
    index,
    path: error.instancePath === '' ? '(root)' : error.instancePath,
    message: error.message ?? 'failed validation',
  }));
}

function validateAll<T>(rows: readonly unknown[], key: string, schema: object): ValidationOutcome<T> {
  const validate = validatorFor(key, schema);
  const valid: T[] = [];
  const problems: ValidationProblem[] = [];

  rows.forEach((row, index) => {
    if (validate(row)) valid.push(row as T);
    else problems.push(...describe(validate.errors, index));
  });

  return { valid, problems };
}

export function validateElasticityFits<T>(rows: readonly unknown[]): ValidationOutcome<T> {
  return validateAll<T>(rows, 'elasticity_fit', elasticityFitSchema);
}

/**
 * Bands, with the cross-field invariant JSON Schema cannot express.
 *
 * `low <= expected_units <= high` is not something draft 2020-12 can state, so a
 * band with `low` above `expected` passes the schema and is caught only by the
 * database CHECK — which surfaces as a 500 from a write, long after the useful
 * error message was available. CP4 hit exactly that.
 *
 * It matters more than tidiness: this interval decides auto-rollback, and an
 * inverted one would make every day look like a breach.
 */
export function validateExpectedBands<T>(rows: readonly unknown[]): ValidationOutcome<T> {
  const outcome = validateAll<T>(rows, 'expected_band', expectedBandSchema);

  const valid: T[] = [];
  for (const row of outcome.valid) {
    const band = row as unknown as { low: number; high: number; expected_units: number; day?: string };
    const index = rows.indexOf(row as unknown);

    if (!(band.low <= band.expected_units)) {
      outcome.problems.push({
        index,
        path: '/low',
        message: `low (${band.low}) must not exceed expected_units (${band.expected_units})${band.day ? ` on ${band.day}` : ''}`,
      });
      continue;
    }
    if (!(band.expected_units <= band.high)) {
      outcome.problems.push({
        index,
        path: '/high',
        message: `high (${band.high}) must not be below expected_units (${band.expected_units})${band.day ? ` on ${band.day}` : ''}`,
      });
      continue;
    }
    valid.push(row);
  }

  return { valid, problems: outcome.problems };
}
