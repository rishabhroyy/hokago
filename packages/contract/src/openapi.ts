import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import type { OpenAPIObject } from "openapi3-ts/oas30";
import { HealthResponse } from "./health.js";

export function buildOpenApiDocument(): OpenAPIObject {
  const registry = new OpenAPIRegistry();

  registry.registerPath({
    method: "get",
    path: "/health",
    summary: "Health check",
    responses: {
      200: {
        description: "Service is healthy",
        content: { "application/json": { schema: HealthResponse } },
      },
    },
  });

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.0",
    info: { title: "hokago API", version: "0.0.0" },
  });
}
