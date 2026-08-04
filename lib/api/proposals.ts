import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import guardrailsSchema from '../../contracts/guardrails.schema.json';
import proposalSchema from '../../contracts/proposal_request.schema.json';
import type { StoreAdapter } from '../adapters/types';
import type { ForecastResult, ProposalRequest } from '../contracts';
import { buildForecast } from '../engine/forecast';
import type { Product, Shop } from '../types';
import { MerchantApiError } from './merchant';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(guardrailsSchema);
const validateProposal = ajv.compile(proposalSchema);

export interface ProposalProblem {
  path: string;
  message: string;
}

function problems(errors: ErrorObject[] | null | undefined): ProposalProblem[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath === '' ? '(root)' : error.instancePath,
    message: error.message ?? 'failed validation',
  }));
}

export function parseProposal(body: unknown): ProposalRequest {
  if (!validateProposal(body)) {
    throw new MerchantApiError(
      'invalid_proposal',
      'Check the highlighted proposal fields and try again.',
      400,
      problems(validateProposal.errors),
    );
  }
  return body as unknown as ProposalRequest;
}

export interface PreparedForecast {
  forecast: ForecastResult;
  products: Product[];
}

/** Load only the authenticated tenant's rows and run the side-effect-free engine. */
export async function prepareForecast(
  adapter: StoreAdapter,
  shop: Shop,
  proposal: ProposalRequest,
): Promise<PreparedForecast> {
  const found = await adapter.getProductsByVariantGids(shop.id, proposal.variant_gids);
  const byGid = new Map(found.map((product) => [product.variant_gid, product]));
  const products = proposal.variant_gids
    .map((variantGid) => byGid.get(variantGid))
    .filter((product): product is Product => product !== undefined);

  if (products.length !== proposal.variant_gids.length) {
    throw new MerchantApiError(
      'variant_not_found',
      'One or more selected variants no longer exist in this store.',
      404,
    );
  }

  const [orderDays, fits] = await Promise.all([
    adapter.getOrderDays(shop.id, { variant_gids: proposal.variant_gids }),
    adapter.getLatestFits(shop.id, proposal.variant_gids),
  ]);

  return {
    products,
    forecast: buildForecast({
      shop: { currency: shop.currency, timezone: shop.timezone },
      products,
      orderDays,
      change: proposal.change,
      horizonDays: proposal.horizon_days,
      fits,
    }),
  };
}
