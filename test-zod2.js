const { z } = require("zod");
const s = z.coerce.number().int().min(1).max(100).default(100).optional();
console.log("Undefined:", s.parse(undefined));
