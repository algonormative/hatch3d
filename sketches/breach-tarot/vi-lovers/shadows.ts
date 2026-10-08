import * as THREE from 'three';

/**
 * What geometry shades on the ground: every triangle dropped along the light onto y = 0, as flat
 * triangles (for a coverage mask on the sheet). `light` points from the ground toward the light.
 */
export function shadowOf(geometries: THREE.BufferGeometry[], light: THREE.Vector3): THREE.BufferGeometry {
  const out: number[] = [];
  const v = new THREE.Vector3();
  for (const g of geometries) {
    const pos = g.getAttribute('position'), index = g.getIndex();
    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(pos, index ? index.getX(i) : i);
      const y = Math.max(0, v.y);
      out.push(v.x - light.x * y / light.y, 0, v.z - light.z * y / light.y);
    }
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
}
