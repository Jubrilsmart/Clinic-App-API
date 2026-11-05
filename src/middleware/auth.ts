import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

export function registerAuth(app: FastifyInstance) {
  const API_KEY = process.env.API_KEY;

  if (!API_KEY) {
    throw new Error("API_KEY is missing from environment variables");
  }

  app.addHook("onRequest", async (request, reply) => {
    const providedKey = request.headers["x-api-key"];

    if (typeof providedKey !== "string") {
      return reply.code(401).send({
        error: "Missing or invalid API key",
      });
    }

    const providedBuffer = Buffer.from(providedKey);
    const expectedBuffer = Buffer.from(API_KEY);

    if (
      providedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      return reply.code(401).send({
        error: "Missing or invalid API key",
      });
    }
  });
}