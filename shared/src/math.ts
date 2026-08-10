import { z } from "zod";

/**
 * Tuple form, not {x,y,z}. Roughly half the tokens in a model payload and it
 * round-trips through JSON Schema without object-shape drift.
 */
export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

/** xyzw, three.js order. */
export const Quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Quat = z.infer<typeof Quat>;

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];
export const ZERO_VEC3: Vec3 = [0, 0, 0];
