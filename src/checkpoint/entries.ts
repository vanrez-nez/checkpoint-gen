export interface PolarEntryFrame {
  index: number;
  angle: number;
  axisX: number;
  axisZ: number;
  lateralX: number;
  lateralZ: number;
  rotationY: number;
}

export function createPolarEntryFrames(entryCount: number): PolarEntryFrame[] {
  if (!Number.isInteger(entryCount) || entryCount < 1) {
    throw new RangeError("Entry count must be a positive integer.");
  }

  return Array.from({ length: entryCount }, (_, index) => {
    const angle = (index / entryCount) * Math.PI * 2;

    return {
      index,
      angle,
      axisX: Math.sin(angle),
      axisZ: Math.cos(angle),
      lateralX: Math.cos(angle),
      lateralZ: -Math.sin(angle),
      rotationY: angle,
    };
  });
}
