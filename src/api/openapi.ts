import { readFileSync } from "node:fs";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";

const swaggerUiCss = readFileSync(
  new URL(import.meta.resolve("swagger-ui-dist/swagger-ui.css")),
  "utf8",
).replace(/\/\*# sourceMappingURL=.*?\*\//g, "");
const swaggerUiBundle = readFileSync(
  new URL(import.meta.resolve("swagger-ui-dist/swagger-ui-bundle.js")),
  "utf8",
);
const swaggerUiStandalonePreset = readFileSync(
  new URL(
    import.meta.resolve("swagger-ui-dist/swagger-ui-standalone-preset.js"),
  ),
  "utf8",
);

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

export function createSwaggerUiHtml(
  document: ReturnType<typeof createOpenApiDocument>,
): string {
  const serializedDocument = JSON.stringify(document)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connectia RAG API</title>
  <style>${swaggerUiCss}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script>${swaggerUiBundle}</script>
  <script>${swaggerUiStandalonePreset}</script>
  <script>
    window.ui = SwaggerUIBundle({
      spec: ${serializedDocument},
      dom_id: "#swagger-ui",
      deepLinking: true,
      validatorUrl: null,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: "StandaloneLayout"
    });
  </script>
</body>
</html>`;
}
