import type { AgentConfig } from "@opencode-ai/sdk";
import { z } from "zod";

export const MAGIC_CONTEXT_AGENT_OVERRIDE_KEYS = ["historian", "dreamer", "sidekick"] as const;

const PermissionValueSchema = z.enum(["ask", "allow", "deny"]);

const PermissionSchema = z
    .object({
        edit: PermissionValueSchema.optional(),
        bash: z
            .union([PermissionValueSchema, z.record(z.string(), PermissionValueSchema)])
            .optional(),
        webfetch: PermissionValueSchema.optional(),
        doom_loop: PermissionValueSchema.optional(),
        external_directory: PermissionValueSchema.optional(),
    })
    .optional();

export const AgentOverrideConfigSchema = z.object({
    model: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    prompt: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    disable: z.boolean().optional(),
    description: z.string().optional(),
    mode: z.enum(["subagent", "primary", "all"]).optional(),
    color: z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/)
        .optional(),
    maxSteps: z.number().optional(),
    permission: PermissionSchema,
    maxTokens: z.number().optional(),
    variant: z.string().optional(),
    fallback_models: z.union([z.string(), z.array(z.string())]).optional(),
});

export type AgentOverrideConfig = z.infer<typeof AgentOverrideConfigSchema> & Partial<AgentConfig>;
