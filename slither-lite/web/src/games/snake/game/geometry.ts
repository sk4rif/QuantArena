export function wrapCoordinate(value: number, halfExtent: number): number {
  const size = halfExtent * 2;
  return ((value + halfExtent) % size + size) % size - halfExtent;
}

export function nearestWrappedCoordinate(value: number, reference: number, halfExtent: number): number {
  const size = halfExtent * 2;
  return value + Math.round((reference - value) / size) * size;
}

export function wrappedDelta(value: number, halfExtent: number): number {
  return wrapCoordinate(value, halfExtent);
}

export function gravitationalOffset(
  deltaX: number,
  deltaY: number,
  boundaryRadius: number,
  coreRadius: number,
  attractorRadius: number,
): { x: number; y: number } {
  const distance = Math.hypot(deltaX, deltaY);
  const maximumOffset = Math.max(0, boundaryRadius - coreRadius);
  if (distance === 0 || maximumOffset === 0) return { x: 0, y: 0 };
  const surfaceGap = Math.max(0, distance - attractorRadius - boundaryRadius);
  const pullRange = boundaryRadius * 4;
  const strength = 1 - Math.min(1, surfaceGap / Math.max(1, pullRange));
  const offset = maximumOffset * strength * strength;
  return { x: deltaX / distance * offset, y: deltaY / distance * offset };
}
