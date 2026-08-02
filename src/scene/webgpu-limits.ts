/** Default WebGPU device limit that was exceeded by eight point-light shadows. */
export const DEFAULT_SAMPLED_TEXTURES_PER_SHADER_STAGE = 16;
export const DEFAULT_SAMPLERS_PER_SHADER_STAGE = 16;

/**
 * The current physical-material pipeline needs 17 sampled textures when every
 * supported fire-glow pair casts a shadow. Request some adapter-provided
 * headroom, but never demand more than the adapter advertises or more than the
 * app elects to reserve.
 */
export const MIN_FIRE_GLOW_SHADOW_SAMPLED_TEXTURES = 17;
export const MAX_REQUESTED_SAMPLED_TEXTURES = 48;
export const FULL_SUN_SHADOW_CASCADES = 3;
export const REDUCED_SUN_SHADOW_CASCADES = 2;

export function requestedSampledTextureLimit(
  adapterLimit: number | null | undefined,
): number | null {
  if (
    adapterLimit === null
    || adapterLimit === undefined
    || !Number.isFinite(adapterLimit)
    || adapterLimit < MIN_FIRE_GLOW_SHADOW_SAMPLED_TEXTURES
  ) {
    return null;
  }

  return Math.min(Math.floor(adapterLimit), MAX_REQUESTED_SAMPLED_TEXTURES);
}

export function supportsFireGlowShadows(
  sampledTextureLimit: number | null | undefined,
  samplerLimit: number | null | undefined,
  sunShadowCascades = fireGlowShadowCascadeCount(
    sampledTextureLimit,
    samplerLimit,
  ),
): boolean {
  const requiredBindings = fireGlowShadowBindingCount(sunShadowCascades);
  return sampledTextureLimit !== null
    && sampledTextureLimit !== undefined
    && samplerLimit !== null
    && samplerLimit !== undefined
    && sampledTextureLimit >= requiredBindings
    && samplerLimit >= requiredBindings;
}

/** Requests a higher sampler limit only when the adapter can actually supply it. */
export function requestedSamplerLimit(
  adapterLimit: number | null | undefined,
): number | null {
  return requestedSampledTextureLimit(adapterLimit);
}

/**
 * Eight local shadow maps plus three sun cascades need 17 sampler bindings.
 * A standard 16-sampler device keeps every local shadow by using two sun
 * cascades instead; devices with the higher limit retain all three.
 */
export function fireGlowShadowCascadeCount(
  sampledTextureLimit: number | null | undefined,
  samplerLimit: number | null | undefined,
): number {
  return sampledTextureLimit !== null
    && sampledTextureLimit !== undefined
    && samplerLimit !== null
    && samplerLimit !== undefined
    && sampledTextureLimit >= MIN_FIRE_GLOW_SHADOW_SAMPLED_TEXTURES
    && samplerLimit >= MIN_FIRE_GLOW_SHADOW_SAMPLED_TEXTURES
    ? FULL_SUN_SHADOW_CASCADES
    : REDUCED_SUN_SHADOW_CASCADES;
}

export function fireGlowShadowBindingCount(sunShadowCascades: number): number {
  return MIN_FIRE_GLOW_SHADOW_SAMPLED_TEXTURES
    - (FULL_SUN_SHADOW_CASCADES - sunShadowCascades);
}
