import "server-only";

// Entry point for app code (Server Components, Route Handlers, Server Actions). Fails the build if a client module imports it.
export { getPrisma } from "./prisma";
