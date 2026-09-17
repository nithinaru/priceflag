/**
 * Admin GraphQL documents.
 *
 * Kept in one file so the field set is reviewable in a single place — a sync that
 * silently stops requesting `unitCost` would degrade every profit number in the
 * product without failing anything.
 *
 * Every field here was verified against the live 2026-07 API on a development
 * store before it was written down, not inferred from documentation.
 *
 * Page sizes are deliberately modest. The Admin API's cost budget is a leaky
 * bucket (2000 cap, 100/s restore on this store), and nested connections multiply:
 * `products(first: 50) { variants(first: 100) }` is already a large query.
 */

export const PRODUCTS_PAGE = /* GraphQL */ `
  query PriceflagProducts($first: Int!, $cursor: String, $variantsFirst: Int!) {
    products(first: $first, after: $cursor, sortKey: ID) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        status
        vendor
        productType
        tags
        isGiftCard
        updatedAt
        requiresSellingPlan
        sellingPlanGroupsCount {
          count
        }
        featuredMedia {
          preview {
            image {
              url
            }
          }
        }
        variants(first: $variantsFirst) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            sku
            price
            compareAtPrice
            inventoryQuantity
            availableForSale
            sellingPlanGroupsCount {
              count
            }
            inventoryItem {
              id
              unitCost {
                amount
              }
            }
          }
        }
      }
    }
  }
`;

/** Continuation for the rare product with more variants than one page holds. */
export const PRODUCT_VARIANTS_PAGE = /* GraphQL */ `
  query PriceflagProductVariants($id: ID!, $first: Int!, $cursor: String) {
    product(id: $id) {
      id
      variants(first: $first, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          title
          sku
          price
          compareAtPrice
          inventoryQuantity
          availableForSale
          sellingPlanGroupsCount {
            count
          }
          inventoryItem {
            id
            unitCost {
              amount
            }
          }
        }
      }
    }
  }
`;

/**
 * Orders for the history window.
 *
 * `originalTotalSet` and `discountedTotalSet` are line totals, not unit prices —
 * dividing by quantity is what gives a realized unit price. Refunds are read on
 * the order rather than separately so a refund can be attributed to the day it
 * happened, which is often not the day of the sale.
 */
export const ORDERS_PAGE = /* GraphQL */ `
  query PriceflagOrders($first: Int!, $cursor: String, $query: String!, $lineItemsFirst: Int!) {
    orders(first: $first, after: $cursor, query: $query, sortKey: CREATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        createdAt
        test
        lineItems(first: $lineItemsFirst) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            quantity
            variant {
              id
            }
            originalTotalSet {
              shopMoney {
                amount
              }
            }
            discountedTotalSet {
              shopMoney {
                amount
              }
            }
          }
        }
        refunds {
          id
          createdAt
          refundLineItems(first: 50) {
            nodes {
              quantity
              subtotalSet {
                shopMoney {
                  amount
                }
              }
              lineItem {
                variant {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const ORDER_LINE_ITEMS_PAGE = /* GraphQL */ `
  query PriceflagOrderLineItems($id: ID!, $first: Int!, $cursor: String) {
    order(id: $id) {
      id
      lineItems(first: $first, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          quantity
          variant {
            id
          }
          originalTotalSet {
            shopMoney {
              amount
            }
          }
          discountedTotalSet {
            shopMoney {
              amount
            }
          }
        }
      }
    }
  }
`;

/**
 * The smallest possible "who owns this store" read, for the OAuth callback.
 *
 * Deliberately not `SHOP_INFO`: that one is the sync's settings read and pulls
 * timezone, currency and plan, none of which the sign-up needs. The callback
 * runs inside the merchant's redirect, so it asks for two fields and gets out.
 *
 * `shop.email` is the shop owner's address (`contactEmail` is the public-facing
 * one customers write to). Neither field requires an access scope of its own —
 * verified against shopify.dev's Shop object docs, 2026-09.
 */
export const SHOP_OWNER = /* GraphQL */ `
  query PriceflagShopOwner {
    shop {
      name
      email
    }
  }
`;

export const SHOP_INFO = /* GraphQL */ `
  query PriceflagShop {
    shop {
      name
      myshopifyDomain
      ianaTimezone
      currencyCode
      contactEmail
      plan {
        displayName
      }
    }
  }
`;

/** Cheap upper bound so progress can show a denominator instead of a spinner. */
export const COUNTS = /* GraphQL */ `
  query PriceflagCounts($ordersQuery: String!) {
    productsCount {
      count
    }
    ordersCount(query: $ordersQuery) {
      count
      precision
    }
  }
`;
