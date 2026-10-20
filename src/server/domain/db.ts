import type { PrismaClient } from '../../generated/prisma/client'

export type Db = PrismaClient
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]
