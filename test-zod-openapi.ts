import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

const app = new OpenAPIHono();

const route = createRoute({
  method: "get",
  path: "/",
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(100).optional()
    })
  },
  responses: { 200: { description: "ok" } }
});

app.openapi(route, (c) => {
  return c.json(c.req.valid("query"));
});

const req = new Request("http://localhost/");
app.fetch(req).then(res => res.json()).then(console.log).catch(console.error);

// Also test empty string limit
const req2 = new Request("http://localhost/?limit=");
app.fetch(req2).then(res => res.json()).then(res => console.log("empty limit:", res)).catch(console.error);
