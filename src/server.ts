import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { createBookingController } from "./controllers/booking-controller.js";
import { registerAuth } from "./middleware/auth.js";
import { BookingRepository } from "./repositories/booking-repository.js";
import { registerBookingRoutes } from "./routes/booking-routes.js";
import { BookingService } from "./services/booking-service.js";

const app = Fastify({
  logger: false,
});
const prisma = new PrismaClient();

const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  process.env.FRONTEND_URL,
].filter((origin): origin is string => Boolean(origin));

await app.register(cors, {
  origin: allowedOrigins,
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-API-Key", "Idempotency-Key"],
  exposedHeaders: ["Retry-After"],
});

registerAuth(app);
const bookingRepository = new BookingRepository(prisma);
const bookingService = new BookingService(bookingRepository);
const bookingController = createBookingController(bookingService);
await registerBookingRoutes(app, bookingController);
app.addHook("onClose", async () => {
  await prisma.$disconnect();
});

app.get("/", async () => ({
  message: "Clinic Booking API is running!",
  version: "1.0.0",
}));

const start = async () => {
  try {
    await prisma.$connect();
    await app.listen({
      port: Number(process.env.PORT) || 4000,
      host: "0.0.0.0",
    });
  } catch (error) {
    app.log.error(error);
    await prisma.$disconnect();
    process.exit(1);
  }
};

await start();