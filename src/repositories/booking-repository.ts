import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

export type BookingStatus = "confirmed" | "cancelled";

export interface Slot {
  id: string;
  provider: string;
  start: string;
  end: string;
}

export interface SlotWithAvailability extends Slot {
  available: boolean;
}

export interface Booking {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: BookingStatus;
  created_at: string;
}

export interface BookingPayload {
  slot_id: string;
  name: string;
  email: string;
}

export type BookingError =
  | "slot_not_found"
  | "slot_started"
  | "slot_booked"
  | "idempotency_conflict"
  | "booking_not_found"
  | "booking_already_cancelled";

export type BookingQueryError = "invalid_limit" | "invalid_cursor";

export type CreateBookingResult =
  | { success: true; booking: Booking; replayed: boolean }
  | { success: false; error: BookingError | "rate_limited"; retryAfter?: number };

export type CancelBookingResult =
  | { success: true; booking: Booking }
  | { success: false; error: "booking_not_found" | "booking_already_cancelled" };

export interface BookingQueryResult {
  bookings: Booking[];
  next_cursor: string | null;
}

interface Cursor {
  createdAt: string;
  id: string;
}

const BOOKING_WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_MINUTE = 5;

export class BookingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async resetSlots(slots: Slot[]): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.bookingAttempt.deleteMany();
      await transaction.idempotencyKey.deleteMany();
      await transaction.slot.deleteMany();
      await transaction.slot.createMany({
        data: slots.map((slot) => ({
          id: slot.id.trim(),
          provider: slot.provider.trim(),
          startAt: new Date(slot.start),
          endAt: new Date(slot.end),
        })),
      });
    });
  }

  async listSlots(provider?: string): Promise<SlotWithAvailability[]> {
    const slots = await this.prisma.slot.findMany({
      where: provider ? { provider } : {},
      orderBy: [{ startAt: "asc" }, { id: "asc" }],
      include: {
        bookings: {
          where: { status: "confirmed" },
          select: { id: true },
        },
      },
    });

    return slots.map(({ bookings, ...slot }) => ({
      id: slot.id,
      provider: slot.provider,
      start: slot.startAt.toISOString(),
      end: slot.endAt.toISOString(),
      available: bookings.length === 0,
    }));
  }

  async createBooking(
    payload: BookingPayload,
    idempotencyKey?: string,
  ): Promise<CreateBookingResult> {
    const requestHash = hashBookingPayload(payload);

    return this.prisma.$transaction(async (transaction) => {
      if (idempotencyKey) {
        await acquireAdvisoryLock(
          transaction,
          `idempotency:${idempotencyKey}`,
        );

        const existing = await transaction.idempotencyKey.findUnique({
          where: { key: idempotencyKey },
        });

        if (existing) {
          if (existing.requestHash !== requestHash) {
            return { success: false, error: "idempotency_conflict" };
          }

          return {
            success: true,
            booking: parsePersistedBooking(existing.response),
            replayed: true,
          };
        }
      }

      const rateLimit = await checkRateLimit(transaction, payload.email);

      if (!rateLimit.allowed) {
        return {
          success: false,
          error: "rate_limited",
          retryAfter: rateLimit.retryAfter,
        };
      }

      await acquireAdvisoryLock(transaction, `slot:${payload.slot_id}`);

      const slot = await transaction.slot.findUnique({
        where: { id: payload.slot_id },
      });

      if (!slot) {
        return { success: false, error: "slot_not_found" };
      }

      if (slot.startAt.getTime() <= Date.now()) {
        return { success: false, error: "slot_started" };
      }

      const existingBooking = await transaction.booking.findFirst({
        where: { slotId: payload.slot_id, status: "confirmed" },
      });

      if (existingBooking) {
        return { success: false, error: "slot_booked" };
      }

      const bookingRecord = await transaction.booking.create({
        data: {
          id: randomUUID(),
          slotId: payload.slot_id,
          name: payload.name,
          email: payload.email,
          status: "confirmed",
        },
      });
      const booking = mapBooking(bookingRecord);

      if (idempotencyKey) {
        await transaction.idempotencyKey.create({
          data: {
            key: idempotencyKey,
            requestHash,
            response: {
              id: booking.id,
              slot_id: booking.slot_id,
              name: booking.name,
              email: booking.email,
              status: booking.status,
              created_at: booking.created_at,
            },
          },
        });
      }

      return { success: true, booking, replayed: false };
    });
  }

  async getBooking(id: string): Promise<Booking | null> {
    const booking = await this.prisma.booking.findUnique({ where: { id } });
    return booking ? mapBooking(booking) : null;
  }

  async listBookingsForEmail(
    email: string,
    limit: number,
    cursor?: string,
  ): Promise<BookingQueryResult | { error: BookingQueryError }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return { error: "invalid_limit" };
    }

    const decodedCursor = cursor ? decodeCursor(cursor) : null;

    if (cursor && !decodedCursor) {
      return { error: "invalid_cursor" };
    }

    if (decodedCursor && !isUuid(decodedCursor.id)) {
      return { error: "invalid_cursor" };
    }

    const afterCursor = decodedCursor
      ? {
          OR: [
            { createdAt: { gt: new Date(decodedCursor.createdAt) } },
            {
              createdAt: new Date(decodedCursor.createdAt),
              id: { gt: decodedCursor.id },
            },
          ],
        }
      : {};

    const result = await this.prisma.booking.findMany({
      where: {
        email: { equals: email.trim(), mode: "insensitive" },
        ...afterCursor,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
    });

    const hasMore = result.length > limit;
    const page = hasMore ? result.slice(0, limit) : result;
    const lastBooking = page.at(-1);

    return {
      bookings: page.map(mapBooking),
      next_cursor:
        hasMore && lastBooking
          ? encodeCursor({
              createdAt: lastBooking.createdAt.toISOString(),
              id: lastBooking.id,
            })
          : null,
    };
  }

  async cancelBooking(id: string): Promise<CancelBookingResult> {
    return this.prisma.$transaction(async (transaction) => {
      const booking = await transaction.booking.findUnique({
        where: { id },
      });

      if (!booking) {
        return { success: false, error: "booking_not_found" };
      }

      await acquireAdvisoryLock(transaction, `booking:${id}`);

      const currentBooking = await transaction.booking.findUniqueOrThrow({
        where: { id },
      });

      if (currentBooking.status === "cancelled") {
        return { success: false, error: "booking_already_cancelled" };
      }

      const cancelled = await transaction.booking.update({
        where: { id },
        data: { status: "cancelled" },
      });

      return { success: true, booking: mapBooking(cancelled) };
    });
  }
}

async function checkRateLimit(
  transaction: Prisma.TransactionClient,
  email: string,
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const normalizedEmail = email.trim().toLowerCase();

  await acquireAdvisoryLock(
    transaction,
    `booking-attempts:${normalizedEmail}`,
  );

  const cutoff = new Date(Date.now() - BOOKING_WINDOW_MS);
  await transaction.bookingAttempt.deleteMany({
    where: {
      email: normalizedEmail,
      attemptedAt: { lte: cutoff },
    },
  });

  const recentAttempts = await transaction.bookingAttempt.findMany({
    where: { email: normalizedEmail },
    orderBy: { attemptedAt: "asc" },
    take: MAX_ATTEMPTS_PER_MINUTE,
  });
  await transaction.bookingAttempt.create({
    data: { email: normalizedEmail },
  });

  if (recentAttempts.length < MAX_ATTEMPTS_PER_MINUTE) {
    return { allowed: true };
  }

  const oldestAttempt = recentAttempts[0]?.attemptedAt;
  const retryAfter = oldestAttempt
    ? Math.max(
        1,
        Math.ceil(
          (oldestAttempt.getTime() + BOOKING_WINDOW_MS - Date.now()) / 1000,
        ),
      )
    : 60;

  return { allowed: false, retryAfter };
}

function mapBooking(
  booking: {
    id: string;
    slotId: string;
    name: string;
    email: string;
    status: string;
    createdAt: Date;
  },
): Booking {
  if (booking.status !== "confirmed" && booking.status !== "cancelled") {
    throw new Error(`Unexpected booking status in database: ${booking.status}`);
  }

  return {
    id: booking.id,
    slot_id: booking.slotId,
    name: booking.name,
    email: booking.email,
    status: booking.status,
    created_at: booking.createdAt.toISOString(),
  };
}

async function acquireAdvisoryLock(
  transaction: Prisma.TransactionClient,
  key: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtext(${key}))::text AS lock_acquired
  `;
}

function hashBookingPayload(payload: BookingPayload): string {
  return JSON.stringify({
    email: payload.email,
    name: payload.name,
    slot_id: payload.slot_id,
  });
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): Cursor | null {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );

    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("createdAt" in decoded) ||
      !("id" in decoded) ||
      typeof decoded.createdAt !== "string" ||
      !Number.isFinite(Date.parse(decoded.createdAt)) ||
      typeof decoded.id !== "string"
    ) {
      return null;
    }

    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    return null;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function parsePersistedBooking(value: Prisma.JsonValue): Booking {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.id !== "string" ||
    typeof value.slot_id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.email !== "string" ||
    (value.status !== "confirmed" && value.status !== "cancelled") ||
    typeof value.created_at !== "string"
  ) {
    throw new Error("Stored idempotency response is not a valid booking");
  }

  return {
    id: value.id,
    slot_id: value.slot_id,
    name: value.name,
    email: value.email,
    status: value.status,
    created_at: value.created_at,
  };
}
