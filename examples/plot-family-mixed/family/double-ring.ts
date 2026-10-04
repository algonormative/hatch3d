import type { Legacy3DComposition, Legacy3DLayer } from "@hatch3d/plot-core/spatial";

const doubleRing: Legacy3DComposition & { description: string; tags: string[] } = {
  id: "doubleRing",
  name: "Double Ring",
  description: "Interlocked torus rings with conoid connector",
  tags: ["geometric", "rings", "symmetric"],
  category: "3d",
  hatchGroups: ["Rings", "Connector"],
  macros: {
    scale: {
      label: "Scale",
      default: 0.5,
      targets: [
        { param: "ringRadius", fn: "linear", strength: 1.0 },
        { param: "connectorSpread", fn: "linear", strength: 1.0 },
      ],
    },
    separation: {
      label: "Separation",
      default: 0.5,
      targets: [
        { param: "ringSpacing", fn: "linear", strength: 1.0 },
        { param: "connectorHeight", fn: "linear", strength: 1.0 },
      ],
    },
  },
  controls: {
    ringSpacing: { type: "slider", label: "Ring Spacing", default: 1.3, min: 0.2, max: 8, group: "Structure" },
    ringRadius: { type: "slider", label: "Ring Radius", default: 2, min: 0.5, max: 8, group: "Structure" },
    ringThickness: { type: "slider", label: "Ring Thickness", default: 0.15, min: 0.03, max: 1.0, group: "Shape" },
    ringSquish: { type: "slider", label: "Ring Squish", default: 0.3, min: 0.1, max: 4.0, group: "Shape" },
    connectorHeight: { type: "slider", label: "Connector Height", default: 2.5, min: 0.5, max: 10, group: "Shape" },
    connectorSpread: { type: "slider", label: "Connector Spread", default: 1.8, min: 0.3, max: 8, group: "Shape" },
    connectorFanAngle: { type: "slider", label: "Fan Angle", default: 1.2, min: 0.2, max: 5, group: "Shape" },
    showConnector: { type: "toggle", label: "Show Connector", default: true, group: "Visibility" },
    ringOffset: { type: "xy", label: "Ring Offset", default: [0, 0], min: -0.5, max: 0.5, group: "Visibility" },
  },
  layers: (p): Legacy3DLayer[] => {
    const v = p.values;
    const ringSpacing = v.ringSpacing as number;
    const ringRadius = v.ringRadius as number;
    const ringThickness = v.ringThickness as number;
    const ringSquish = v.ringSquish as number;
    const connectorHeight = v.connectorHeight as number;
    const connectorSpread = v.connectorSpread as number;
    const connectorFanAngle = v.connectorFanAngle as number;
    const showConnector = v.showConnector as boolean;
    const ringOffset = v.ringOffset as [number, number];

    const layers: Legacy3DLayer[] = [
      {
        surface: "torus",
        params: { majorR: ringRadius, minorR: ringThickness, ySquish: ringSquish },
        hatch: { ...p.hatchParams, family: p.hatchParams.family ?? "u" },
        transform: { y: ringSpacing, x: ringOffset[0], z: ringOffset[1] },
        group: "Rings",
      },
      {
        surface: "torus",
        params: { majorR: ringRadius, minorR: ringThickness, ySquish: ringSquish },
        hatch: { ...p.hatchParams, family: p.hatchParams.family ?? "u" },
        transform: { y: -ringSpacing, x: -ringOffset[0], z: -ringOffset[1] },
        group: "Rings",
      },
    ];
    if (showConnector) {
      layers.push({
        surface: "conoid",
        params: { height: connectorHeight, spread: connectorSpread, fanAngle: connectorFanAngle },
        hatch: { ...p.hatchParams, family: p.hatchParams.family ?? "v" },
        transform: { y: 0 },
        group: "Connector",
      });
    }
    return layers;
  },
};
export default doubleRing;
