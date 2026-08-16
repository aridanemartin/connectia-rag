import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";

export const openApiRegistry = new OpenAPIRegistry();

openApiRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
});

openApiRegistry.registerPath({
  method: "get",
  path: "/health/live",
  security: [],
  responses: {
    200: {
      description: "El proceso de la API está activo.",
    },
  },
});

export function createOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(openApiRegistry.definitions);

  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Connectia RAG API",
      version: "1.0.0",
    },
    security: [{ bearerAuth: [] }],
  });
}
