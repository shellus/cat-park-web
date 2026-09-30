/**
 * Web rules in source units. Challenge movement, rope and camera values follow the asset
 * package's player and map configuration (see docs/game-behavior.md); the rest are web choices.
 */
export const GAME_RULES = {
  fixedStep: 1 / 60,
  maxFrameTime: 0.25,
  sourceUnitsPerPhysicsUnit: 100,
  player: { halfWidth: 40, halfHeight: 54, mass: 1, friction: 0, maxSpeed: 3200 },
  lobby: { speed: 680, acceleration: 5800, spawnSpacing: 140 },
  challenge: {
    gravity: -3800,
    /** MaxHVelocity: pressing a direction never accelerates past this. */
    maxSpeed: 500,
    /** HForce per unit mass; applied on the ground and in the air alike (HForceScaleFlying = 1). */
    acceleration: 5000,
    /** UpForce impulse per unit mass. */
    jumpSpeed: 1300,
    jumpBuffer: 0.12,
    coyoteTime: 0.2,
    spawn: { x: -850, y: -360 },
    spawnSpacing: 150,
    /** DieY: a player this far below the map's bottom edge dies. */
    dieMargin: 1500,
    /** Reference view the map bounds are laid out for; the camera shows exactly this much. */
    view: { width: 2340, height: 1080 },
    keyRadius: 145,
    starRadius: 135,
    exitRadius: 280,
  },
  rope: {
    restLength: 650,
    /** CoeElastic, applied along the rope between the two body centres. */
    stiffness: 40,
    /** DamperElastic: share of the relative speed along the rope each end loses per step. */
    dampingPerStep: 0.2,
    /** Guard against numerical blow-up on very large stretches. */
    maxAcceleration: 18000,
    /** FootJointForcePulling: a standing player is dragged once the rope pulls harder than this. */
    footJointForce: 3000,
    /** Drawing only: where the rope meets each cat. */
    endpointA: { x: 20, y: -40 },
    endpointB: { x: -10, y: -40 },
  },
  render: { interpolationSeconds: 0.08, maxInterpolationJump: 900, lobbyZoom: 0.62 },
} as const;
