import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  BookingError,
  BookingQueryError,
} from "../repositories/booking-repository.js";
import type { BookingService } from "../services/booking-service.js";

const slotSchema = z.object({
  id: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  start: z.iso.datetime(),
  end: z.iso.datetime(),
});

const resetBodySchema = z.object({
  slots: z.array(slotSchema),
});

const bookingBodySchema = z.object({
  slot_id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  email: z.email().trim(),
});

const slotsQuerySchema = z.object({
  provider: z.string().optional(),
});

const bookingsQuerySchema = z.object({
  email: z.email(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  cursor: z.string().optional(),
});

const bookingIdParamsSchema = z.object({
  id: z.string().min(1),
});

export function createBookingController(bookingService: BookingService) {
  return {
    resetSlots: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = resetBodySchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: "Invalid slot payload" });
      }

      await bookingService.resetSlots(body.data.slots);
      return reply.send({ ok: true });
    },

    listSlots: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = slotsQuerySchema.safeParse(request.query);

      if (!query.success) {
        return reply.code(400).send({ error: "Invalid query parameters" });
      }

      return reply.send({
        slots: await bookingService.listSlots(query.data.provider),
      });
    },

    createBooking: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = bookingBodySchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({
          error: "Missing or invalid booking details",
        });
      }

      const idempotencyKey = readHeaderValue(request, "idempotency-key");
      const result = await bookingService.createBooking(body.data, idempotencyKey);

      if (!result.success) {
        if (result.error === "rate_limited") {
          reply.header("Retry-After", String(result.retryAfter));
        }

        return sendDomainError(reply, result.error);
      }

      return reply.code(201).send(result.booking);
    },

    listBookings: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = bookingsQuerySchema.safeParse(request.query);

      if (!query.success) {
        return reply.code(400).send({ error: "Invalid booking query" });
      }

      const result = await bookingService.listBookings(
        query.data.email,
        query.data.limit,
        query.data.cursor,
      );

      if ("error" in result) {
        return sendDomainError(reply, result.error);
      }

      return reply.send(result);
    },

    getBooking: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = bookingIdParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ error: "Invalid booking id" });
      }

      const booking = await bookingService.getBooking(params.data.id);

      if (!booking) {
        return reply.code(404).send({ error: "booking not found" });
      }

      return reply.send(booking);
    },

    cancelBooking: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = bookingIdParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ error: "Invalid booking id" });
      }

      const result = await bookingService.cancelBooking(params.data.id);

      if (!result.success) {
        return sendDomainError(reply, result.error);
      }

      return reply.send(result.booking);
    },
  };
}

function readHeaderValue(request: FastifyRequest, header: string): string | undefined {
  const value = request.headers[header];

  if (typeof value === "string") {
    return value;
  }

  return value?.[0];
}

function sendDomainError(
  reply: FastifyReply,
  error: BookingError | BookingQueryError | "rate_limited",
) {
  switch (error) {
    case "slot_not_found":
    case "booking_not_found":
      return reply.code(404).send({ error: errorMessage(error) });
    case "slot_started":
      return reply.code(400).send({ error: "slot has already started" });
    case "slot_booked":
      return reply.code(409).send({ error: "slot already booked" });
    case "idempotency_conflict":
      return reply.code(422).send({
        error: "idempotency key reused with a different body",
      });
    case "booking_already_cancelled":
      return reply.code(409).send({ error: "booking already cancelled" });
    case "rate_limited":
      return reply.code(429).send({ error: "Too many booking attempts" });
    case "invalid_limit":
      return reply.code(400).send({ error: "Invalid limit" });
    case "invalid_cursor":
      return reply.code(400).send({ error: "Invalid cursor" });
  }
}

function errorMessage(error: "slot_not_found" | "booking_not_found"): string {
  return error === "slot_not_found" ? "slot not found" : "booking not found";
}
