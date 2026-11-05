CREATE TABLE "slots" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "start_at" TIMESTAMPTZ(6) NOT NULL,
  "end_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "slots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "slots_valid_time_range" CHECK ("end_at" > "start_at")
);

CREATE TABLE "bookings" (
  "id" UUID NOT NULL,
  "slot_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bookings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bookings_valid_status" CHECK ("status" IN ('confirmed', 'cancelled')),
  CONSTRAINT "bookings_slot_id_fkey"
    FOREIGN KEY ("slot_id") REFERENCES "slots" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "bookings_one_confirmed_per_slot"
  ON "bookings" ("slot_id")
  WHERE "status" = 'confirmed';

CREATE INDEX "bookings_email_created_at_id"
  ON "bookings" ("email", "created_at", "id");

CREATE TABLE "idempotency_keys" (
  "key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "response" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "booking_attempts" (
  "id" BIGSERIAL NOT NULL,
  "email" TEXT NOT NULL,
  "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "booking_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "booking_attempts_email_time"
  ON "booking_attempts" ("email", "attempted_at");
