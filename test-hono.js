const { z } = require("zod");
const pageQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(100).optional(),
  offset: z.coerce.number().int().min(0).default(0).optional(),
};
const schema = z.object(pageQuery);

console.log("Empty object:", schema.parse({}));
console.log("Empty strings:", schema.safeParse({ limit: "", offset: "" }));
