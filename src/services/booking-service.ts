import {
  BookingRepository,
  type BookingQueryError,
  type BookingQueryResult,
  type BookingPayload,
  type CreateBookingResult,
  type Slot,
} from "../repositories/booking-repository.js";

export type BookingCreationResult =
  | CreateBookingResult
  | { success: false; error: "rate_limited"; retryAfter: number };

export type BookingListResult =
  | BookingQueryResult
  | { error: BookingQueryError };

export class BookingService {
  constructor(private readonly bookingRepository: BookingRepository) {}

  resetSlots(slots: Slot[]) {
    return this.bookingRepository.resetSlots(slots);
  }

  listSlots(provider?: string) {
    return this.bookingRepository.listSlots(provider);
  }

  async createBooking(
    payload: BookingPayload,
    idempotencyKey?: string,
  ): Promise<BookingCreationResult> {
    const normalizedPayload: BookingPayload = {
      slot_id: payload.slot_id.trim(),
      name: payload.name.trim(),
      email: payload.email.trim().toLowerCase(),
    };
    return this.bookingRepository.createBooking(normalizedPayload, idempotencyKey);
  }

  listBookings(
    email: string,
    limit: number,
    cursor?: string,
  ): Promise<BookingListResult> {
    return this.bookingRepository.listBookingsForEmail(email, limit, cursor);
  }

  getBooking(id: string) {
    return this.bookingRepository.getBooking(id);
  }

  cancelBooking(id: string) {
    return this.bookingRepository.cancelBooking(id);
  }
}
