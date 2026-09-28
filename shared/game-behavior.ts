/** Temporary web rules, not claims about the original game's runtime. Source units throughout. */
export const GAME_RULES = {
  fixedStep: 1 / 60,
  maxFrameTime: 0.25,
  sourceUnitsPerPhysicsUnit: 100,
  player: { halfWidth: 40, halfHeight: 54, mass: 1, friction: 0, maxSpeed: 3200 },
  lobby: { speed: 680, acceleration: 5800, spawnSpacing: 140 },
  challenge: {
    gravity: -3800, speed: 1300, groundAcceleration: 9000, airAcceleration: 3600,
    jumpSpeed: 2200, jumpBuffer: .12, coyoteTime: .10,
    spawn: { x: -850, y: -360 }, spawnSpacing: 150, deathY: -1750,
    keyRadius: 145, starRadius: 135, exitRadius: 280,
  },
  rope: {
    restLength: 650, horizontalStiffness: 30, upwardStiffness: 70, stiffness: 40,
    // Exported damping=.2 has unknown units; this coefficient is deliberately retuned for Rapier.
    damping: 7, maxAcceleration: 18000, endpointA: { x: 20, y: -40 }, endpointB: { x: -10, y: -40 },
  },
  render: { interpolationSeconds: .08, maxInterpolationJump: 900, lobbyZoom: .62, challengeZoom: .42 },
} as const;
