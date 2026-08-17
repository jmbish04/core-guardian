import { z } from "zod";
const PAGE_MAX = 100;
const schema = z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_MAX).optional();
console.log("undefined:", schema.parse(undefined));
console.log("empty string:", schema.safeParse("").success ? schema.parse("") : schema.safeParse("").error.errors[0].message);
