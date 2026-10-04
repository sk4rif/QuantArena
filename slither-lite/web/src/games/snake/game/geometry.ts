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
