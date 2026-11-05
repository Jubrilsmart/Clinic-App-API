# Clinic Booking API

A REST API for managing clinic appointment slots and patient bookings. It
provides endpoints to list available times, create and look up bookings, and
cancel appointments.

The API uses Fastify and Prisma with PostgreSQL to persist data between
requests. It also supports API-key authentication, request validation,
idempotent booking requests, cursor-based booking history, and per-email rate
limits.

For local database setup, migration instructions, and development commands,
see [`readme.md`](./readme.md).
