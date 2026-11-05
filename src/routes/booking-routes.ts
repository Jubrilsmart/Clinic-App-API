import type { FastifyInstance } from "fastify";
import type { createBookingController } from "../controllers/booking-controller.js";

type BookingController = ReturnType<typeof createBookingController>;

export async function registerBookingRoutes(
  app: FastifyInstance,
  controller: BookingController,
) {
  app.post("/reset", controller.resetSlots);
  app.get("/slots", controller.listSlots);
  app.post("/bookings", controller.createBooking);
  app.get("/bookings", controller.listBookings);
  app.get("/bookings/:id", controller.getBooking);
  app.delete("/bookings/:id", controller.cancelBooking);
}
