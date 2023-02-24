/* eslint-disable @typescript-eslint/no-explicit-any */

import { Request, RouteOptions } from "@hapi/hapi";
import Joi from "joi";

import { redb } from "@/common/db";
import { logger } from "@/common/logger";
import { buildContinuation, regex, splitContinuation } from "@/common/utils";

const version = "v1";

export const getCrossPostingOrdersV1Options: RouteOptions = {
  description: "Cross posting orders",
  notes: "Get a list of cross posting orders with status",
  tags: ["api", "Orders"],
  plugins: {
    "hapi-swagger": {
      order: 5,
    },
  },
  validate: {
    query: Joi.object({
      ids: Joi.alternatives(Joi.array().items(Joi.number()), Joi.string()).description(
        "id(s) to search for."
      ),
      continuation: Joi.string()
        .pattern(regex.base64)
        .description("Use continuation token to request next offset of items."),
      limit: Joi.number()
        .integer()
        .min(1)
        .max(50)
        .default(50)
        .description("Amount of items returned in response."),
    }),
  },
  response: {
    schema: Joi.object({
      orders: Joi.array().items(
        Joi.object({
          id: Joi.number().required(),
          orderbook: Joi.string().required(),
          status: Joi.string().required(),
          statusReason: Joi.string().allow(null, ""),
          createdAt: Joi.string().required(),
          updatedAt: Joi.string().required(),
        })
      ),
      continuation: Joi.string().pattern(regex.base64).allow(null),
    }).label(`getCrossPostingOrders${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(
        `get-cross-posting-orders-${version}-handler`,
        `Wrong response schema: ${error}`
      );
      throw error;
    },
  },
  handler: async (request: Request) => {
    const query = request.query as any;

    try {
      let baseQuery = `
        SELECT
          cross_posting_orders.id,
          cross_posting_orders.orderbook,
          cross_posting_orders.status,
          cross_posting_orders.status_reason,
          extract(epoch from cross_posting_orders.created_at) AS created_at,
          cross_posting_orders.updated_at
        FROM cross_posting_orders
      `;

      // Filters
      const conditions: string[] = [];

      if (query.ids) {
        if (Array.isArray(query.ids)) {
          conditions.push(`id IN ($/ids:csv/)`);
        } else {
          conditions.push(`id = $/ids/`);
        }
      }

      if (query.continuation) {
        const [createdAt, id] = splitContinuation(
          query.continuation,
          /^\d+(.\d+)?_0x[a-f0-9]{64}$/
        );
        (query as any).createdAt = createdAt;
        (query as any).id = id;

        conditions.push(`(created_at, id) < (to_timestamp($/createdAt/), $/id/)`);
      }

      if (conditions.length) {
        baseQuery += " WHERE " + conditions.map((c) => `(${c})`).join(" AND ");
      }

      // Sorting
      baseQuery += ` ORDER BY created_at DESC, id DESC`;

      // Pagination
      baseQuery += ` LIMIT $/limit/`;

      const rawResult = await redb.manyOrNone(baseQuery, query);

      let continuation = null;

      if (rawResult.length === query.limit) {
        continuation = buildContinuation(
          rawResult[rawResult.length - 1].created_at + "_" + rawResult[rawResult.length - 1].id
        );
      }

      const result = rawResult.map(async (r) => {
        return {
          id: Number(r.id),
          orderbook: r.orderbook,
          status: r.status,
          statusReason: r.status_reason,
          createdAt: new Date(r.created_at * 1000).toISOString(),
          updatedAt: new Date(r.updated_at).toISOString(),
        };
      });

      return {
        orders: await Promise.all(result),
        continuation,
      };
    } catch (error) {
      logger.error(`get-cross-posting-orders-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};