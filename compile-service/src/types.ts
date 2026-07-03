import { z } from 'zod';

export const BaseTypeSchema = z.enum(['ERC20', 'ERC721A', 'ERC1155']);
export type BaseType = z.infer<typeof BaseTypeSchema>;

export const ChainSchema = z.enum(['mainnet', 'sepolia', 'base', 'base-sepolia']);
export type Chain = z.infer<typeof ChainSchema>;

export const CompileRequestSchema = z.object({
  base: BaseTypeSchema,
  mechanic: z.string(),
  modules: z.array(z.string()),
  params: z.record(z.string(), z.unknown()),
  chain: ChainSchema,
});
export type CompileRequest = z.infer<typeof CompileRequestSchema>;

export const CompileResultSchema = z.object({
  configHash: z.string(),
  bytecode: z.string(),
  abi: z.array(z.record(z.string(), z.unknown())),
  gasEstimate: z.number().optional(),
  warnings: z.array(z.string()),
});
export type CompileResult = z.infer<typeof CompileResultSchema>;
