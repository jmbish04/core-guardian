import { z } from "zod";
const PAGE_MAX = 100;
const schema = z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_MAX).optional();
const res = schema.safeParse("");
console.log(res);
