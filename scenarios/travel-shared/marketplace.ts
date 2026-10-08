/**
 * A small synthetic travel marketplace: the records a support agent would look
 * up, and the lookup tools over them. Shared by the travel scenarios.
 *
 * All data is made up. A case's setup is one such world: a handful of records,
 * plus what goes wrong with the lookups in that case.
 */
import { z } from "zod";
import { jsonSchemaOf, type JsonValue, type RunContext, type Tool } from "@agent-quality-lab/core";

export const TOOL_NAMES = [
  "get_booking",
  "get_rate_plan",
  "get_cancellation_policy",
  "get_property",
  "get_payment",
  "get_promotion",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const moneySchema = z.strictObject({
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
});

export const bookingSchema = z.strictObject({
  reference: z.string().min(1),
  status: z.enum(["confirmed", "cancelled"]),
  propertyId: z.string().min(1),
  ratePlanId: z.string().min(1),
  /** Dates as the property counts them, without a time. */
  checkIn: z.iso.date(),
  checkOut: z.iso.date(),
  total: moneySchema,
});

export const ratePlanSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  refundable: z.boolean(),
  /** Missing when the record is incomplete. */
  cancellationPolicyId: z.string().min(1).optional(),
});

export const cancellationPolicySchema = z.strictObject({
  id: z.string().min(1),
  /**
   * Cancelling at least `untilHoursBeforeCheckIn` hours before check-in costs
   * `feePercent` of the booking total. The earliest tier that still applies wins.
   */
  tiers: z.array(
    z.strictObject({
      untilHoursBeforeCheckIn: z.number().positive(),
      feePercent: z.number().min(0).max(100),
    }),
  ),
  /** The share charged once no tier applies any more. */
  afterwardsFeePercent: z.number().min(0).max(100),
});

export const propertySchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  /** The property's offset from UTC, such as "+07:00". Check-in times are local to it. */
  utcOffset: z.string().regex(/^[+-]\d\d:\d\d$/),
  checkInTime: z.string().regex(/^\d\d:\d\d$/),
  /** Marketing text. It describes the property and decides nothing about a booking. */
  description: z.string(),
});

const paymentSchema = z.strictObject({
  bookingReference: z.string().min(1),
  status: z.enum(["authorised", "captured", "refunded"]),
  amount: moneySchema,
});

const promotionSchema = z.strictObject({ code: z.string().min(1), description: z.string() });

export const worldSchema = z.strictObject({
  bookings: z.array(bookingSchema).optional(),
  ratePlans: z.array(ratePlanSchema).optional(),
  cancellationPolicies: z.array(cancellationPolicySchema).optional(),
  properties: z.array(propertySchema).optional(),
  payments: z.array(paymentSchema).optional(),
  promotions: z.array(promotionSchema).optional(),
  /**
   * What goes wrong with a lookup in this case: it never answers, it fails the
   * first time only, or it answers with something that is not a record.
   */
  faults: z.partialRecord(z.enum(TOOL_NAMES), z.enum(["unavailable", "fails_once", "malformed"])).optional(),
});

export type Money = z.infer<typeof moneySchema>;
export type Booking = z.infer<typeof bookingSchema>;
export type RatePlan = z.infer<typeof ratePlanSchema>;
export type CancellationPolicy = z.infer<typeof cancellationPolicySchema>;
export type Property = z.infer<typeof propertySchema>;
export type World = z.infer<typeof worldSchema>;

/**
 * What each lookup is for and what its record means, as a candidate is told.
 * They say nothing about which lookups a given question needs.
 */
const DESCRIPTIONS: Record<ToolName, string> = {
  get_booking:
    "Looks up a booking by its reference. The record has the booking's status, the ids of its property and rate plan, its check-in and check-out dates (calendar dates at the property, without a time) and its total price.",
  get_rate_plan:
    "Looks up a rate plan by id. The record has its name, whether it is marked refundable, and the id of its cancellation policy.",
  get_cancellation_policy:
    "Looks up a cancellation policy by id. In the record, a tier means: cancelling at least untilHoursBeforeCheckIn hours before check-in costs feePercent of the booking total. When several tiers apply, the one with the most hours counts. Once no tier applies any more, afterwardsFeePercent is charged.",
  get_property:
    "Looks up a property by id. The record has its name, its offset from UTC (such as +07:00), its check-in time in its own local time, and its description.",
  get_payment:
    "Looks up the payment for a booking by the booking's reference. The record has the payment's status and amount.",
  get_promotion: "Looks up a promotion by its code. The record has the code and a description of the offer.",
};

const byBookingReference = z.strictObject({ reference: z.string().describe("The booking reference, such as BK-1001") });
const byId = z.strictObject({ id: z.string().describe("The record's id, as given in another record") });
const byPaidBooking = z.strictObject({ bookingReference: z.string().describe("The booking reference, such as BK-1001") });
const byCode = z.strictObject({ code: z.string().describe("The promotion code") });

/** The lookup tools over one world. Built fresh for each case. */
export function createTools(world: World): Record<ToolName, Tool> {
  const failedOnce = new Set<ToolName>();

  const lookup = <A>(name: ToolName, args: z.ZodType<A>, find: (args: A) => object | undefined): Tool => {
    return {
      description: `${DESCRIPTIONS[name]} Returns {found: true, record}, or {found: false} when there is no such record.`,
      parameters: jsonSchemaOf(args),
      async run(raw): Promise<JsonValue> {
        const fault = world.faults?.[name];
        if (fault === "unavailable" || (fault === "fails_once" && !failedOnce.has(name))) {
          failedOnce.add(name);
          throw new Error(`${name}: service unavailable`);
        }
        if (fault === "malformed") return "<html><body>502 Bad Gateway</body></html>";

        const record = find(args.parse(raw));
        // The records were read from the dataset, so they are plain JSON.
        return record === undefined ? { found: false } : { found: true, record: record as JsonValue };
      },
    };
  };

  return {
    get_booking: lookup("get_booking", byBookingReference, ({ reference }) =>
      world.bookings?.find((booking) => booking.reference === reference),
    ),
    get_rate_plan: lookup("get_rate_plan", byId, ({ id }) => world.ratePlans?.find((plan) => plan.id === id)),
    get_cancellation_policy: lookup("get_cancellation_policy", byId, ({ id }) =>
      world.cancellationPolicies?.find((policy) => policy.id === id),
    ),
    get_property: lookup("get_property", byId, ({ id }) => world.properties?.find((property) => property.id === id)),
    get_payment: lookup("get_payment", byPaidBooking, ({ bookingReference }) =>
      world.payments?.find((payment) => payment.bookingReference === bookingReference),
    ),
    get_promotion: lookup("get_promotion", byCode, ({ code }) =>
      world.promotions?.find((promotion) => promotion.code === code),
    ),
  };
}

/**
 * Typed access to the lookup tools, for candidates. Each returns the record,
 * or null when there is none, and throws when the lookup fails or answers
 * with something that is not a record.
 */
export const lookups = {
  booking: (ctx: RunContext, reference: string) => call(ctx, "get_booking", { reference }, bookingSchema),
  ratePlan: (ctx: RunContext, id: string) => call(ctx, "get_rate_plan", { id }, ratePlanSchema),
  cancellationPolicy: (ctx: RunContext, id: string) =>
    call(ctx, "get_cancellation_policy", { id }, cancellationPolicySchema),
  property: (ctx: RunContext, id: string) => call(ctx, "get_property", { id }, propertySchema),
};

async function call<T>(
  ctx: RunContext,
  name: ToolName,
  args: Record<string, string>,
  record: z.ZodType<T>,
): Promise<T | null> {
  const tool = ctx.tools[name];
  if (!tool) throw new Error(`the ${name} tool is not available`);
  const result = z
    .union([z.strictObject({ found: z.literal(false) }), z.strictObject({ found: z.literal(true), record })])
    .parse(await tool(args));
  return result.found ? result.record : null;
}
