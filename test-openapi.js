const { z } = require("zod");
const { createRoute, OpenAPIHono } = require("@hono/zod-openapi");

const pageQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(100).optional(),
  offset: z.coerce.number().int().min(0).default(0).optional(),
};

const route = createRoute({
  method: 'get',
  path: '/',
  request: {
    query: z.object(pageQuery)
  },
  responses: {
    200: { description: "ok" }
  }
});

const app = new OpenAPIHono();
app.openapi(route, (c) => c.json({}));
const docs = app.getOpenAPIDocument({
  openapi: '3.0.0',
  info: { version: '1', title: 'My API' },
});
console.log(JSON.stringify(docs.paths['/'].get.parameters, null, 2));
