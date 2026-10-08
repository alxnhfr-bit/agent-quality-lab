import { z } from "zod";
import type { JsonValue } from "./artifact.ts";

/**
 * A zod schema as a JSON Schema, for telling a candidate what shape a tool's
 * arguments or an answer must have. A convenience for scenarios written with
 * zod; the contracts themselves only ask for the JSON Schema.
 */
export function jsonSchemaOf(schema: z.ZodType): JsonValue {
  const { $schema: _, ...rest } = z.toJSONSchema(schema);
  return rest as JsonValue;
}
