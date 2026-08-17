import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const app = new Hono();
const schema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100).optional()
});

app.get("/", zValidator("query", schema), (c) => {
  return c.json(c.req.valid("query"));
});

const req = new Request("http://localhost/");
app.fetch(req).then(res => res.json()).then(console.log).catch(console.error);
