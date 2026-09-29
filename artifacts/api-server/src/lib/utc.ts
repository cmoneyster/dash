// The database stores times without a time zone and the code (written on
// Replit, which runs in UTC) assumes the process clock is UTC. Pin it so a
// host or laptop in another zone behaves identically. Imported first by
// src/index.ts so it runs before any Date is sent to Postgres.
process.env.TZ = "UTC";
